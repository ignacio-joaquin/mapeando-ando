import { LANGS, useLang, useT } from "../i18n";

/**
 * Toggle ES / EN. Las dos opciones siempre a la vista y la activa marcada con
 * borde, fondo y aria-pressed: no depende solo del color.
 */
export function LanguageToggle() {
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  const t = useT();

  return (
    <div className="flex gap-1" role="group" aria-label={t.app.langNav}>
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={l === lang}
          onClick={() => setLang(l)}
          className={
            l === lang
              ? "rounded border border-rust bg-rust/15 px-2 py-0.5 text-xs font-semibold text-fg"
              : "rounded border border-line px-2 py-0.5 text-xs text-muted hover:text-fg"
          }
        >
          {l === "es" ? "ES" : "EN"}
        </button>
      ))}
    </div>
  );
}
