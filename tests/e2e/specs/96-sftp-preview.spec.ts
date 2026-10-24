// Preview a remote file while downloading it through the transfer queue.
// The preview must stay read-only and must not consume transfer jobs/events.
import { expect } from "chai";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import { clickSave, fillPasswordHostForm, getHostId, openNewHostModal, waitForModalClosed } from "../helpers/host.js";
import { deleteEntry, refreshExplorer, waitForEntry, waitForExplorer } from "../helpers/sftp-ops.js";
import { activeSftpSessionId, sftpEnqueueDownload, sftpEnqueueUpload, waitForSftpTransferResult } from "../helpers/transfers.js";

describe("SFTP Quick Look", () => {
    beforeEach(async () => { await resetApp(); await waitForDashboard(); });

    it("previews escaped text while a queued download preserves the remote bytes", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({ label: "preview-target", host: process.env.SSHD_PASS_HOST ?? "sshd-pass",
            port: Number(process.env.SSHD_PASS_PORT ?? 2222), username: process.env.SSH_USER ?? "testuser",
            password: process.env.SSH_PASS ?? "testpass" });
        await clickSave(); await waitForModalClosed();
        const hostId = await getHostId("preview-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        const dir = await mkdtemp(join(tmpdir(), "e2e-preview-"));
        const name = `preview-${Date.now()}.txt`;
        const payload = "<script>window.previewMustNotRun = true</script>\nRemote content\n";
        const local = join(dir, name);
        await writeFile(local, payload, "utf8");
        const sessionId = await activeSftpSessionId();
        const [uploadId] = await sftpEnqueueUpload(sessionId, [local], "/config");
        expect(await waitForSftpTransferResult(uploadId)).to.equal("Completed");
        await refreshExplorer(); await waitForEntry(name);

        await (await $("[aria-label='Thumbnail view']")).click();
        expect(await (await $("[aria-label='Directory contents']")).getAttribute("data-view-mode")).to.equal("grid");

        const row = await $(`[data-entry-name='${name}']`);
        await row.click(); await browser.keys([" "]);
        const dialog = await $("[data-testid='quick-look']");
        await dialog.waitForDisplayed();
        const contents = await $("[aria-label='File contents']");
        await contents.waitForDisplayed();
        expect(await contents.getText()).to.include("<script>");
        expect(await dialog.$$("script")).to.have.length(0);

        const [downloadId] = await sftpEnqueueDownload(sessionId, [`/config/${name}`], dir + "/download");
        expect(await waitForSftpTransferResult(downloadId)).to.equal("Completed");
        expect(await readFile(join(dir, "download", name), "utf8")).to.equal(payload);
        expect(await dialog.isDisplayed()).to.equal(true);
        await browser.keys(["Escape"]);
        await dialog.waitForDisplayed({ reverse: true });
        await (await $("[aria-label='List view']")).click();
        await deleteEntry(name);
    });
});
