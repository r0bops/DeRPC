export interface PageResult {
  html: string;
  title: string;
  bind?: (root: HTMLElement) => void | (() => void);
}
