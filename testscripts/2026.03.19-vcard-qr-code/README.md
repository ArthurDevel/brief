# vCard QR Code Format Test

## Goal

Find the correct vCard format that prevents phones from splitting "Brief.ai - Call with your Inbox" into separate first/middle/last name fields.

## Problem

When a phone scans a vCard QR code, it parses the N (structured name) and FN (formatted name) fields. Most phones split on spaces, so "Brief.ai - Call with your Inbox" ends up as first name "Brief.ai", middle name "- Call with your", last name "Inbox" (or similar).

## Approach

Generate multiple QR code images, each encoding a different vCard format. Scan each on a real phone and check which one keeps the full string as a single unsplit name.

## Variants

| File | Strategy |
|------|----------|
| variant-1-fn-only.png | FN field only, no N field |
| variant-2-empty-n-org-company.png | Empty N, ORG field, X-ABShowAs:COMPANY |
| variant-3-firstname-only.png | Full string in first name position of N field |
| variant-4-lastname-only.png | Full string in last name position of N field |
| variant-5-vcard4-kind-org.png | vCard 4.0 with KIND:org |
| variant-6-escaped-spaces.png | Backslash-escaped spaces in N field |
| variant-7-no-n-org-only.png | No N field, ORG field instead |
| variant-8-nickname.png | NICKNAME + ORG + X-ABShowAs:COMPANY |

## Instructions

```bash
pnpm install && pnpm tsx generate.ts
```

Then open the `output/` folder and scan each QR code with a phone camera.
