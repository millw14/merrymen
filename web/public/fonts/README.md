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
