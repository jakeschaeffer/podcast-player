import { Icon } from "./Icon";

/** `size` is a pixel number, or a CSS length (such as a variable) when the layout decides the size. */
export function Artwork({ src, alt = "", size, radius = 12, className = "" }: { src: string | null | undefined; alt?: string; size: number | string; radius?: number; className?: string }) {
  const style = { width: size, height: size, borderRadius: radius };
  if (!src) {
    return (
      <div className={`art art--empty ${className}`} style={style} aria-hidden="true">
        <Icon name="library" size={typeof size === "number" ? Math.round(size * 0.4) : 56} />
      </div>
    );
  }
  return <img className={`art ${className}`} style={style} src={src} alt={alt} loading="lazy" />;
}
