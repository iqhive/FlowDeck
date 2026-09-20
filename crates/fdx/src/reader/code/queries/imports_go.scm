; Import specifiers for Go.
;
; Capturing `interpreted_string_literal_content` / `raw_string_literal_content`
; rather than the literal node drops the quote characters, so the specifier is
; the bare import path (`fmt`, `github.com/acme/app/internal/convert`).
;
; `import_spec` is unanchored, so single imports and grouped `import ( ... )`
; blocks are handled by the same pattern.

(import_spec
  path: [(interpreted_string_literal (interpreted_string_literal_content) @import.source)
         (raw_string_literal (raw_string_literal_content) @import.source)]) @import
