; Call sites for Go.

; foo()
(call_expression function: (identifier) @name) @call.unqualified

; pkg.Func() or x.Method()  — package and receiver calls share one shape, so
; the operand is recorded as the qualifier and resolution decides later.
(call_expression
  function: (selector_expression
              operand: (_) @qualifier
              field: (field_identifier) @name)) @call.qualified

; Foo{...} and &Foo{...}
(composite_literal type: (type_identifier) @name) @call.constructor

; pkg.Foo{...}
(composite_literal
  type: (qualified_type
          package: (package_identifier) @qualifier
          name: (type_identifier) @name)) @call.constructor
