# Interface fonts

DM Sans is served locally, with its weight and optical-size axes preserved. The
Latin subset is preloaded; extended Latin is loaded only when the text needs it.

Source: [Google Fonts DM Sans](https://fonts.google.com/specimen/DM+Sans), retrieved
September 5, 2026. Font files are the v17 subsets provided by the Google Fonts CSS
API. The SIL Open Font License is included in `DMSans-OFL.txt`.

DM Sans does not include tabular figures. `Geist-numerals.woff2` supplies only
digits 0–9, so the interface keeps DM Sans letterforms while financial values have
equal-width digits. This variable-weight subset comes from the Google Fonts
[Geist](https://fonts.google.com/specimen/Geist) CSS API (v5, retrieved September 5,
2026), with its license in `Geist-OFL.txt`.

Use the existing Geist Pixel files for prominent balances and funding amounts.
Wallet addresses use the system monospace font.

# The six languages DM Sans cannot write

DM Sans publishes exactly two subsets, `latin` and `latin-ext`. Measured against those
ranges, it covers Spanish, Portuguese, Indonesian and Turkish completely — and covers
Russian, Thai, Chinese, Japanese and Korean not at all.

Vietnamese is the awkward one at **62% covered**, which is worse than none: `U+1EA0–1EF9`
is missing while the base letters around it are present, so "Tiếng Việt" renders half in
DM Sans and half in a system fallback, inside one word. So a locale whose script
interleaves with Latin inside a word changes face entirely rather than being stitched
together per codepoint.

| Locale | Face | Added bytes for that reader |
| --- | --- | --- |
| en, es, pt-BR, id, tr | DM Sans | 0 |
| vi | Inter | ~216 KB |
| ru | Inter | ~100 KB |
| th | Noto Sans Thai + DM Sans | ~26 KB |
| zh, ja, ko | DM Sans + the system CJK face | 0 |

Each subset is declared with its own `unicode-range`, so a reader only fetches what their
text needs and an English reader fetches none of it.

CJK is deliberately **not** a webfont — a full Noto Sans SC is around eight megabytes,
while the system faces are excellent and universally present. The stacks are listed per
language rather than pooled because Han unification means the same codepoint has
different correct shapes in Chinese and Japanese; one shared stack would render Japanese
text in Chinese letterforms.

`Geist Numerals` stays FIRST in every stack. It carries `U+0030–0039` and nothing else,
and being first is the whole mechanism that gives every figure equal-width digits. Move
it and the money columns stop lining up in every language at once, English included.

Inter subsets are the v20 woff2 files from the Google Fonts CSS API (retrieved September
21, 2026), licence in `Inter-OFL.txt`. Noto Sans Thai is v29 from the same API, licence
in `NotoSansThai-OFL.txt`. `web/src/terminal/fonts.test.ts` measures all of the above.
