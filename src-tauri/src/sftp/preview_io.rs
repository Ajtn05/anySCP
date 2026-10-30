//! Cancellation stops new requests, but must not discard a pending SFTP reply.
use std::{future::Future, time::Duration};

use tokio_util::sync::CancellationToken;

use super::SftpError;

pub(super) fn check(token: &CancellationToken) -> Result<(), SftpError> {
    if token.is_cancelled() {
        Err(SftpError::TransferCancelled)
    } else {
        Ok(())
    }
}

/// Only for cancellation-safe waits such as mutexes and semaphore permits.
/// Never pass a protocol request here.
pub(super) async fn cancel_safe<T>(
    token: &CancellationToken,
    wait: impl Future<Output = T>,
) -> Result<T, SftpError> {
    tokio::select! {
        biased;
        _ = token.cancelled() => Err(SftpError::TransferCancelled),
        result = wait => Ok(result),
    }
}

/// Keep polling on cancellation/deadline so the current protocol request and
/// explicit file close finish. russh-sftp bounds each reply wait (10 seconds by
/// default). Dropping a pending OPEN can leak its handle; dropping any request
/// makes its eventual reply produce a misleading "channel closed" warning.
/// Work must check the token between requests, including after acquiring locks.
pub(super) async fn run<T>(
    token: &CancellationToken,
    timeout: Duration,
    timeout_message: &str,
    work: impl Future<Output = Result<T, SftpError>>,
) -> Result<T, SftpError> {
    check(token)?;
    tokio::pin!(work);
    let stopped = tokio::select! {
        biased;
        _ = token.cancelled() => SftpError::TransferCancelled,
        _ = tokio::time::sleep(timeout) => {
            token.cancel();
            SftpError::ProtocolError(timeout_message.into())
        }
        result = &mut work => return result,
    };
    let _ = work.await;
    Err(stopped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[tokio::test]
    async fn deadline_signals_cancellation_and_waits_for_cleanup() {
        let token = CancellationToken::new();
        let cleanup_started = CancellationToken::new();
        let finish_cleanup = CancellationToken::new();
        let cleaned_up = AtomicBool::new(false);
        let work = async {
            token.cancelled().await;
            cleanup_started.cancel();
            finish_cleanup.cancelled().await;
            cleaned_up.store(true, Ordering::SeqCst);
            Ok(())
        };
        let release = async {
            cleanup_started.cancelled().await;
            tokio::task::yield_now().await;
            finish_cleanup.cancel();
        };
        let (result, ()) =
            tokio::join!(run(&token, Duration::ZERO, "test deadline", work), release);
        assert!(
            matches!(result, Err(SftpError::ProtocolError(message)) if message == "test deadline")
        );
        assert!(token.is_cancelled());
        assert!(cleaned_up.load(Ordering::SeqCst));
    }
}
