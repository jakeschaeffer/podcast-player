import { onLinkClick } from "../lib/router";
import { Icon } from "./Icon";

const items = [
  { href: "/", label: "Today", icon: "sun" as const },
  { href: "/library", label: "Library", icon: "library" as const },
  { href: "/snips", label: "Snips", icon: "snip" as const },
];

export function BottomNav({ path }: { path: string }) {
  const pathname = path.split("?")[0] ?? "/";
  return (
    <nav className="nav" aria-label="Main">
      {items.map((it) => {
        const current = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
        return (
          <a key={it.href} href={it.href} onClick={onLinkClick} aria-current={current ? "page" : undefined}>
            <Icon name={it.icon} size={25} />
            {it.label}
          </a>
        );
      })}
    </nav>
  );
}
