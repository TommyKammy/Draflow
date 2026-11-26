export interface SourceRange {
  start: number;
  end: number;
}

export interface LiteralExpr extends SourceRange {
  type: 'Literal';
  value: null | boolean | number | string | undefined;
}

export interface IdentifierExpr extends SourceRange {
  type: 'Identifier';
  name: string;
}

export interface MemberExpr extends SourceRange {
  type: 'Member';
  object: Expr;
  property: Expr;
  computed: boolean;
  optional: boolean;
}

export interface CallExpr extends SourceRange {
  type: 'Call';
  callee: Expr;
  args: Expr[];
  optional: boolean;
}

export interface UnaryExpr extends SourceRange {
  type: 'Unary';
  operator: '!' | '-' | '+';
  argument: Expr;
}

export interface BinaryExpr extends SourceRange {
  type: 'Binary';
  operator: string;
  left: Expr;
  right: Expr;
}

export interface LogicalExpr extends SourceRange {
  type: 'Logical';
  operator: '&&' | '||' | '??';
  left: Expr;
  right: Expr;
}

export interface ConditionalExpr extends SourceRange {
  type: 'Conditional';
  test: Expr;
  consequent: Expr;
  alternate: Expr;
}

export interface ArrayExpr extends SourceRange {
  type: 'Array';
  elements: Expr[];
}

export interface ObjectProperty {
  key: string;
  value: Expr;
}

export interface ObjectExpr extends SourceRange {
  type: 'Object';
  properties: ObjectProperty[];
}

export interface ArrowExpr extends SourceRange {
  type: 'Arrow';
  params: string[];
  body: Expr;
}

export type Expr =
  | LiteralExpr
  | IdentifierExpr
  | MemberExpr
  | CallExpr
  | UnaryExpr
  | BinaryExpr
  | LogicalExpr
  | ConditionalExpr
  | ArrayExpr
  | ObjectExpr
  | ArrowExpr;

export function expressionRange(expression: Expr): SourceRange {
  return { start: expression.start, end: expression.end };
}
