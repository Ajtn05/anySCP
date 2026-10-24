import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PdfPreview from "./PdfPreview";

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument, GlobalWorkerOptions: {} }));

describe("PDF preview lifecycle", () => {
  beforeEach(() => { getDocument.mockReset(); });
  it("renders pages on demand and destroys its worker on close", async () => {
    const renderPage = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
    const getPage = vi.fn(async () => ({ getViewport: () => ({ width: 400, height: 600 }), render: renderPage, cleanup: vi.fn() }));
    const destroy = vi.fn(async () => {});
    getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 3, getPage }), destroy });
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const view = render(<PdfPreview bytes={new ArrayBuffer(5)} />);
    await waitFor(() => expect(screen.getByLabelText("PDF page 1")).toBeVisible());
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(getPage).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByLabelText("Next PDF page"));
    await waitFor(() => expect(screen.getByLabelText("PDF page 2")).toBeVisible());
    expect(getPage).toHaveBeenCalledTimes(2);
    view.unmount(); expect(destroy).toHaveBeenCalledOnce(); context.mockRestore();
  });
  it("handles password requests without retaining the password", async () => {
    const task = { promise: new Promise(() => {}), destroy: vi.fn(async () => {}), onPassword: undefined as unknown as (submit: (password: string) => void) => void };
    getDocument.mockReturnValue(task);
    render(<PdfPreview bytes={new ArrayBuffer(1)} />);
    const submit = vi.fn();
    act(() => task.onPassword(submit));
    const field = screen.getByLabelText("PDF password");
    fireEvent.change(field, { target: { value: "temporary" } });
    fireEvent.click(screen.getByText("Unlock PDF"));
    expect(submit).toHaveBeenCalledWith("temporary");
    act(() => task.onPassword(submit));
    expect(screen.getByLabelText("PDF password")).toHaveValue("");
  });
  it("reports malformed documents and destroys pending loading tasks", async () => {
    const destroy = vi.fn(async () => {});
    getDocument.mockReturnValue({ promise: Promise.reject(new Error("Invalid PDF")), destroy });
    const view = render(<PdfPreview bytes={new ArrayBuffer(1)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid PDF");
    view.unmount(); expect(destroy).toHaveBeenCalledOnce();
  });
});
