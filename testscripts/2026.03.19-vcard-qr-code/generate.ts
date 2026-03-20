/**
 * Generates multiple vCard QR code PNGs to test which format prevents phones
 * from splitting the contact name into first/middle/last fields.
 *
 * - Defines 8 vCard format variants
 * - Generates a QR code PNG (400x400) for each variant in output/
 * - Prints each vCard string to the console for inspection
 */

import QRCode from "qrcode";
import path from "path";

// ============================================================================
// CONSTANTS
// ============================================================================

const PHONE_NUMBER = "+16503999357";
const OUTPUT_DIR = path.join(__dirname, "output");
const QR_SIZE = 400;

// ============================================================================
// VARIANT DEFINITIONS
// ============================================================================

interface VcardVariant {
  filename: string;
  label: string;
  vcard: string;
}

const variants: VcardVariant[] = [
  {
    filename: "variant-1-company-card-lf.png",
    label: "vCard 3.0 company card with LF line endings",
    vcard: [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:;;;;",
      "FN:Brief.ai",
      "ORG:Brief.ai",
      "X-ABShowAs:COMPANY",
      `TEL:${PHONE_NUMBER}`,
      "END:VCARD",
    ].join("\n"),
  },
  {
    filename: "variant-2-company-card-crlf.png",
    label: "vCard 3.0 company card with CRLF line endings (per RFC)",
    vcard: [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:;;;;",
      "FN:Brief.ai",
      "ORG:Brief.ai",
      "X-ABShowAs:COMPANY",
      `TEL:${PHONE_NUMBER}`,
      "END:VCARD",
    ].join("\r\n"),
  },
  {
    filename: "variant-3-firstname-only.png",
    label: "Brief.ai as first name only",
    vcard: [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:;Brief.ai;;;",
      "FN:Brief.ai",
      `TEL:${PHONE_NUMBER}`,
      "END:VCARD",
    ].join("\r\n"),
  },
  {
    filename: "variant-4-vcard4-kind-org.png",
    label: "vCard 4.0 KIND:org",
    vcard: [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "KIND:org",
      "FN:Brief.ai",
      `TEL:${PHONE_NUMBER}`,
      "END:VCARD",
    ].join("\r\n"),
  },
];

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Generates a QR code PNG for each vCard variant and saves it to output/.
 */
async function main(): Promise<void> {
  console.log(`Generating ${variants.length} vCard QR code variants...\n`);

  for (const variant of variants) {
    const outputPath = path.join(OUTPUT_DIR, variant.filename);

    // Print the vCard content for inspection
    console.log(`--- ${variant.filename} (${variant.label}) ---`);
    console.log(variant.vcard);
    console.log();

    // Generate the QR code PNG
    await QRCode.toFile(outputPath, variant.vcard, {
      width: QR_SIZE,
      margin: 2,
    });

    console.log(`  -> Saved to ${outputPath}\n`);
  }

  console.log("Done. Scan each QR code with a phone to test.");
}

main();
