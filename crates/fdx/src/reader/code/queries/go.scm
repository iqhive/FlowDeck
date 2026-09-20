; Symbol definitions for Go.
;
; `type_spec` is captured rather than `type_declaration` so that a grouped
; `type ( A struct{}; B struct{} )` yields one symbol per type instead of one
; symbol per group. Struct types map to `definition.class` to match how Rust
; structs are reported.

; ── types ────────────────────────────────────────────────────────────────────
(type_spec name: (_) @name type: (struct_type)) @definition.class
(type_spec name: (_) @name type: (interface_type)) @definition.interface
(type_spec
  name: (_) @name
  type: [(array_type) (channel_type) (function_type) (generic_type) (map_type)
         (negated_type) (pointer_type) (qualified_type) (slice_type)
         (type_identifier) (parenthesized_type)]) @definition.type
(type_alias name: (_) @name) @definition.type

; ── package-level constants and variables ────────────────────────────────────
; Anchored to `source_file` so function-local `const`/`var` statements are not
; reported as symbols.
(source_file (const_declaration (const_spec name: (_) @name) @definition.constant))
(source_file (var_declaration (var_spec name: (_) @name) @definition.static))
(source_file (var_declaration (var_spec_list (var_spec name: (_) @name) @definition.static)))

; ── functions and methods ────────────────────────────────────────────────────
(function_declaration name: (_) @name) @definition.function
(method_declaration name: (_) @name) @definition.method
; Interface method signatures, reported like Java interface methods.
(method_elem name: (_) @name) @definition.method
