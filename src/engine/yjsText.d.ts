/**
 * yjs 13.6's generated declarations drop YText.toString() (src/types/YText.js defines it, but its JSDoc has no
 * @return, so tsc's d.ts emit omits the override). Without it, typed lint resolves `text.toString()` to
 * Object.prototype.toString and @typescript-eslint/no-base-to-string flags every Y.Text read. This restores the
 * method's real signature; toJSON(), which yjs does declare, just returns this.toString().
 */
import "yjs";

declare module "yjs" {
	interface Text {
		toString(): string;
	}
}
