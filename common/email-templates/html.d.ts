// Wrangler bundles .html imports as text (its default Text module rule).
declare module "*.html" {
  const text: string;
  export default text;
}
