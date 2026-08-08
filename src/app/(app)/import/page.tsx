import { ImportWizard } from "./import-wizard";

export default function ImportPage() {
  return (
    // #191: this screen had no headline, so its largest element was a source
    // glyph. It answers "how do I get my history in?" — say so.
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[21px] font-extrabold tracking-[-.02em] m-0">Bring in your history</h1>
        <p className="text-[12.5px] text-mut mt-1 mb-0">
          From Monito, Khatabook, a bank statement, or any CSV or Excel sheet.
        </p>
      </div>
      <ImportWizard />
    </div>
  );
}
