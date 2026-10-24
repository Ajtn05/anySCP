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
    beforeEach(async () => {
        await resetApp(); await waitForDashboard();
        await openNewHostModal();
        await fillPasswordHostForm({ label: "preview-target", host: process.env.SSHD_PASS_HOST ?? "sshd-pass",
            port: Number(process.env.SSHD_PASS_PORT ?? 2222), username: process.env.SSH_USER ?? "testuser",
            password: process.env.SSH_PASS ?? "testpass" });
        await clickSave(); await waitForModalClosed();
        const hostId = await getHostId("preview-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();
    });

    it("previews escaped text while a queued download preserves the remote bytes", async () => {
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

    it("renders an embedded RAW JPEG above the thumbnail source limit and downloads the original", async () => {
        // Generate an original JPEG fixture in the webview; no system decoder
        // or third-party camera photograph is required by the E2E suite.
        const base64 = await browser.execute(() => {
            const canvas = document.createElement("canvas");
            canvas.width = 2; canvas.height = 4;
            const context = canvas.getContext("2d")!;
            context.fillStyle = "#2266bb"; context.fillRect(0, 0, 2, 4);
            return canvas.toDataURL("image/jpeg").split(",")[1];
        });
        const jpeg = Buffer.from(base64, "base64");
        // Synthetic classic TIFF container with a JPEG offset/length and
        // Orientation=6. Padding proves grid eligibility uses the embedded
        // JPEG budget instead of applying the 8 MiB original-file limit.
        const payload = Buffer.alloc(8 * 1024 * 1024 + 8192);
        payload.write("II", 0); payload.writeUInt16LE(42, 2); payload.writeUInt32LE(16, 4);
        payload.writeUInt16LE(3, 16);
        for (const [index, [tag, type, value]] of [
            [0x0112, 3, 6], [0x0201, 4, 4096], [0x0202, 4, jpeg.length],
        ].entries()) {
            const start = 18 + index * 12;
            payload.writeUInt16LE(tag, start); payload.writeUInt16LE(type, start + 2);
            payload.writeUInt32LE(1, start + 4); payload.writeUInt32LE(value, start + 8);
        }
        jpeg.copy(payload, 4096);
        payload.write("original sensor bytes sentinel", payload.length - 32);
        const directory = await mkdtemp(join(tmpdir(), "e2e-raw-preview-"));
        const name = `preview-${Date.now()}.dng`;
        const local = join(directory, name);
        await writeFile(local, payload);
        const sessionId = await activeSftpSessionId();
        const [uploadId] = await sftpEnqueueUpload(sessionId, [local], "/config");
        expect(await waitForSftpTransferResult(uploadId)).to.equal("Completed");
        await refreshExplorer(); await waitForEntry(name);
        await (await $("[aria-label='Thumbnail view']")).click();
        const row = await $(`[data-entry-name='${name}']`);
        await browser.waitUntil(async () => await browser.execute((filename: string) => {
            const image = document.querySelector<HTMLImageElement>(`[data-entry-name='${filename}'] img`);
            return image?.complete === true && image.naturalWidth === 4 && image.naturalHeight === 2;
        }, name), { timeout: 15_000, timeoutMsg: "RAW thumbnail did not load with container orientation" });
        await row.click(); await browser.keys([" "]);
        const dialog = await $("[data-testid='quick-look']");
        await dialog.waitForDisplayed();
        expect(await dialog.getText()).to.include("Embedded JPEG");
        await browser.waitUntil(async () => await browser.execute(() => {
            const image = document.querySelector<HTMLImageElement>("[data-testid='quick-look'] img");
            return image?.complete === true && image.naturalWidth === 4 && image.naturalHeight === 2;
        }), { timeout: 15_000, timeoutMsg: "RAW Quick Look did not render" });
        const [downloadId] = await sftpEnqueueDownload(sessionId, [`/config/${name}`], join(directory, "download"));
        expect(await waitForSftpTransferResult(downloadId)).to.equal("Completed");
        expect((await readFile(join(directory, "download", name))).equals(payload)).to.equal(true);
        expect(await dialog.isDisplayed()).to.equal(true);
        await browser.keys(["Escape"]);
        await dialog.waitForDisplayed({ reverse: true });
        await deleteEntry(name);
    });
});
