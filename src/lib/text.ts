export const countWord = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;
