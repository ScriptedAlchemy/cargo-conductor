declare module 'bashjsast' {
  export interface BashWord {
    pos?: unknown;
    text: string;
    type: 'Word';
  }

  export interface BashSimpleCommand {
    args?: BashWord[];
    assignments?: readonly unknown[];
    name?: BashWord;
    redirects?: readonly unknown[];
    type: 'SimpleCommand';
  }

  export interface BashScript {
    commands?: readonly unknown[];
    type: 'Script';
  }

  export interface BashToken {
    readonly pos?: { readonly column: number; readonly line: number; readonly offset: number };
    readonly type: string;
    readonly value: string;
  }

  export class Lexer {
    constructor(source: string);
    tokenize(options?: { readonly includeComments?: boolean }): BashToken[];
  }

  export const T: Readonly<Record<string, string>> & {
    readonly COMMENT: string;
    readonly EOF: string;
    readonly NEWLINE: string;
    readonly SEMI: string;
  };

  export function parse(source: string): BashScript;
  export function print(ast: unknown): string;
  export function query(source: string): {
    commands(): string[];
    has(name: string, flag?: string): boolean;
  };
}
