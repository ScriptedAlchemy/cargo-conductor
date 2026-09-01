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

  export function parse(source: string): BashScript;
  export function print(ast: unknown): string;
  export function query(source: string): {
    commands(): string[];
    has(name: string, flag?: string): boolean;
  };
}
