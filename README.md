# Receipt Renamer

Local-only receipt PDF renamer for Node + pnpm.

## Features

- Embedded PDF text extraction first
- OCR fallback with `pdfjs-dist` + `tesseract.js`
- Concurrent processing with `--concurrency`
- Vendor whitelist JSON in the project root
- Date extraction prefers the **first date match** in the document
- If that fails, date extraction falls back to labeled lines like `inv date`, `invoice date`, `transaction date`, and similar
- More careful `time-in` / `time-out` extraction
- Structured JSONL operation log
- Structured JSONL error log
- Optional destination folder structure preservation

## Suggestion
use a "zz-in" and "zz-out" folder at the root level of this project for convenience

## Install

```bash
pnpm install
```

## Basic usage

```bash
pnpm start -- --src "/path/to/source" --dest "/path/to/dest"
```

## Use a custom vendor config file

```bash
pnpm start -- --src "/path/to/source" --dest "/path/to/dest" --vendor-config "/path/to/vendors.json"
```

## Dry run

```bash
pnpm start -- --src "/path/to/source" --dest "/path/to/dest" --dry-run --verbose
```

## Preserve folder structure

```bash
pnpm start -- --src "/path/to/source" --dest "/path/to/dest" --preserve-structure
```

## Output format

```text
YYYY-MM-DD-vendor-time-in-time-out.pdf
YYYY-MM-DD-vendor-time-in-time-out-visa.pdf
```

## Vendor whitelist format

The script looks for `vendors.json` in the project root by default.

Example:

```json
{
  "vendors": [
    {
      "name": "Costco",
      "output": "costco",
      "aliases": ["COSTCO", "COSTCO WHOLESALE"]
    }
  ]
}
```

- `name`: readable label
- `output`: slug to use in the filename
- `aliases`: text variants to try matching before guessing

## Notes

- Source PDFs are scanned recursively.
- Default behavior is copy. Use `--move` to move instead.
- OCR is only used when the embedded text looks too weak.
- Logs are newline-delimited JSON.
