import { Agent } from '@agent-bundle/runtime';
import React from 'react';

/**
 * The three non-happy shapes every document may take, named so a route
 * composes them instead of hand-writing "nothing here" strings.
 */

export const EmptyState = ({ children }: { readonly children: string }) => <Agent.Text>{children}</Agent.Text>;

export interface UnavailableStateProps {
  readonly children: string;
  /** The subsystem that could not be observed (`kache`, `daemon`, …). */
  readonly what: string;
}

/** Something we looked for and honestly could not observe. */
export const UnavailableState = ({ children, what }: UnavailableStateProps) => (
  <Agent.Context>{`${what} unavailable: ${children}`}</Agent.Context>
);

export interface ErrorStateProps {
  readonly children: string;
  readonly code: string;
}

/** A represented failure: the document stays a document, the status flips to error. */
export const ErrorState = ({ children, code }: ErrorStateProps) => <Agent.Error code={code}>{children}</Agent.Error>;
