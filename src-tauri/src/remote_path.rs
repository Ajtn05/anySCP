/// Normalize remote POSIX paths independently of the desktop platform.
fn normalize(path: &str) -> Result<String, String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err("Expected an absolute remote path".into());
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

/// Validate the entire batch before either transport renames its first entry.
pub(crate) fn prepare_move(
    sources: Vec<String>,
    target: String,
) -> Result<(Vec<String>, String), String> {
    let target = normalize(&target)?;
    let sources: Vec<String> = sources
        .iter()
        .map(|source| normalize(source))
        .collect::<Result<_, _>>()?;
    if sources.is_empty() {
        return Err("Select at least one item to move".into());
    }
    for source in &sources {
        if source == "/" || target == *source || target.starts_with(&format!("{source}/")) {
            return Err(format!(
                "Cannot move {source} into itself or one of its subfolders"
            ));
        }
        let parent = source
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("");
        let parent = if parent.is_empty() { "/" } else { parent };
        if target == parent {
            return Err(format!("{source} is already in this folder"));
        }
    }
    Ok((sources, target))
}

#[cfg(test)]
mod tests {
    use super::prepare_move;

    fn prepare(sources: &[&str], target: &str) -> Result<(Vec<String>, String), String> {
        prepare_move(
            sources.iter().map(|s| s.to_string()).collect(),
            target.into(),
        )
    }

    #[test]
    fn accepts_ancestors_root_and_siblings_with_a_shared_prefix() {
        assert!(prepare(&["/home/user/docs/report.txt"], "/home/user").is_ok());
        assert!(prepare(&["/home/user/docs"], "/").is_ok());
        assert!(prepare(&["/home/user/docs"], "/home/user/docs-archive").is_ok());
    }

    #[test]
    fn rejects_self_descendants_and_same_directory_for_the_whole_batch() {
        assert!(prepare(&["/a/file", "/a/folder"], "/a/folder/child").is_err());
        assert!(prepare(&["/a/folder"], "/a/folder").is_err());
        assert!(prepare(&["/a/file"], "/a/").is_err());
        assert!(prepare(&["/file"], "/").is_err());
        assert!(prepare(&["/"], "/a").is_err());
    }

    #[test]
    fn normalizes_before_validation_and_requires_absolute_paths() {
        assert!(prepare(&["/a/folder"], "/b/../a/folder/./child").is_err());
        assert_eq!(
            prepare(&["/a//file"], "/a/../b/").unwrap(),
            (vec!["/a/file".into()], "/b".into())
        );
        assert!(prepare(&["/a/file"], "relative").is_err());
        assert!(prepare(&[], "/a").is_err());
    }
}
