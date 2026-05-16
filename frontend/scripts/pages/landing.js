// Landing page.
//
// Mirrors redpash-components/redpash-demo's welcome surface, including
// the social-login modal. The library's js/modal.js + js/theme.js +
// js/i18n.js logic is replayed here inline (one-time on mount) since
// the router can't execute <script> tags inside injected partials.
//
// Wiring map for the inline onclick handlers in landing.html:
//   openModal('login'|'contact')  → opens #modal-<id>
//   closeModal('login'|'contact') → closes by removing .open
//   doLogin('Google')             → real OAuth start (only wired provider)
//   doLogin('Apple'|…)            → toast "coming soon"
//   doContact()                   → toast (no /api/contact endpoint yet)
//   rpToggleTheme()               → dark ↔ light with spin-icon animation
//   setLang('en'|'fr'|…)          → translation pass (en + fr wired; rest toast)
//   installPWA()                  → owned by main.js (shell scope)
//
// Promotion path: when a second page wants modals / auth / theme /
// i18n, lift these into scripts/ui/*.js modules and import here.

import { toast } from "/scripts/ui/toast.js";

// ── Translation table ────────────────────────────────────────────
// Each row: { sel, en, fr, html? }. html=true → swap innerHTML so the
// translated string can contain markup (<br>, <em>, …). Only `en` and
// `fr` are wired today; the other picker options toast "coming soon".
const I18N = [
  // Hero
  { sel: ".rp-hero-h1",
    en: "Turn messy data into<br /><em>beautiful insights.</em>",
    fr: "Transformez vos données en<br /><em>insights élégants.</em>",
    html: true },

  // CTAs (the <span class="rp-cta-label"> text only — icons stay)
  { sel: '.rp-cta-btn--primary .rp-cta-label',         en: "Start for free",  fr: "Commencer gratuitement" },
  { sel: '.pwa-install-btn .rp-cta-label',             en: "Download",        fr: "Télécharger" },
  { sel: '[aria-label="Talk to us"] .rp-cta-label',    en: "Talk to us",      fr: "Nous contacter" },

  // Float-bar (top-right)
  { sel: '[data-i18n="sign-in"]',                      en: "Sign in",         fr: "Connexion" },

  // Hero step labels
  { sel: ".rp-hero-step--import  .rp-hero-step-lbl",   en: "Import",          fr: "Importer" },
  { sel: ".rp-hero-step--clean   .rp-hero-step-lbl",   en: "Clean",           fr: "Nettoyer" },
  { sel: ".rp-hero-step--report  .rp-hero-step-lbl",   en: "Report",          fr: "Rapport" },
  { sel: ".rp-hero-step--publish .rp-hero-step-lbl",   en: "Publish",         fr: "Publier" },

  // Eyebrow
  { sel: ".rp-eyebrow span",                           en: "No more messy CSVs", fr: "Fini les CSV en désordre" },

  // Rotate prompt
  { sel: ".rp-rotate-prompt p",
    en: "RedPash requires a landscape screen.<br />Please use a tablet or desktop.",
    fr: "RedPash nécessite un écran horizontal.<br />Veuillez utiliser une tablette ou un ordinateur.",
    html: true },

  // Login modal footer
  { sel: "#modal-login .modal-divider + div > span",   en: "Professional or company?", fr: "Professionnel ou entreprise ?" },
  { sel: "#modal-login .modal-link",
    en: 'Contact us <i class="bi bi-arrow-right bi-sm"></i>',
    fr: 'Nous contacter <i class="bi bi-arrow-right bi-sm"></i>',
    html: true },

  // Contact modal
  { sel: "#modal-contact .modal-title",                en: "Get in touch",                                fr: "Prenez contact" },
  { sel: "#modal-contact .modal-sub",                  en: "We'll get back to you within one business day.", fr: "Nous vous répondrons sous un jour ouvrable." },
  { sel: 'label[for="c-name"]',                        en: "Full name",     fr: "Nom complet" },
  { sel: 'label[for="c-email"]',                       en: "Work email",    fr: "E-mail professionnel" },
  { sel: 'label[for="c-company"]',
    en: 'Company <span class="form-opt-lbl">(optional)</span>',
    fr: 'Entreprise <span class="form-opt-lbl">(facultatif)</span>',
    html: true },
  { sel: 'label[for="c-phone"]',
    en: 'Phone <span class="form-opt-lbl">(optional)</span>',
    fr: 'Téléphone <span class="form-opt-lbl">(facultatif)</span>',
    html: true },
  { sel: 'label[for="c-msg"]',                         en: "Message",       fr: "Message" },
  { sel: "#c-msg",                                     en: "Tell us what you need…", fr: "Dites-nous ce dont vous avez besoin…", attr: "placeholder" },
  { sel: "#modal-contact button.btn-primary",
    en: '<i class="bi bi-send-fill bi-sm"></i> Send message',
    fr: '<i class="bi bi-send-fill bi-sm"></i> Envoyer le message',
    html: true },
  { sel: "#modal-contact .rp-contact-note",
    en: 'Or email us at <span style="color:var(--accent)">hello@redpash.com</span>',
    fr: 'Ou écrivez-nous à <span style="color:var(--accent)">hello@redpash.com</span>',
    html: true },

  // Mobile bottom-nav (rebuilt later when we tackle mobile)
  { sel: ".rp-bottom-nav-item:nth-child(1) span",      en: "Home",     fr: "Accueil" },
  { sel: ".rp-bottom-nav-item:nth-child(3) span",      en: "Theme",    fr: "Thème" },
  { sel: ".rp-bottom-nav-item:nth-child(4) span",      en: "Contact",  fr: "Contact" },
  { sel: ".rp-bottom-nav-item:nth-child(5) span",      en: "Sign in",  fr: "Connexion" },
];

// ── Hero eyebrow typewriter phrases ──────────────────────────────
// Phrase list per language. The eyebrow's static HTML matches
// phrases[0]['en'] so the first paint reads correctly before the
// typist loop kicks in (1.8s after mount).
window.__typistPhrases = {
  en: [
    "No more messy CSVs",
    "Fix duplicates in one click",
    "Spot bad date formats instantly",
    "Turn raw data into charts",
    "Works offline — it's a PWA",
    "Zero code, zero headaches",
  ],
  fr: [
    "Fini les CSV en désordre",
    "Corrigez les doublons en un clic",
    "Repérez les mauvais formats de dates",
    "Transformez vos données en graphiques",
    "Fonctionne hors ligne — c'est une PWA",
    "Zéro code, zéro prise de tête",
  ],
};

export default function mount(root) {
  // Brand-mark one-shot reveal (first hover sticks open).
  const mark = root.querySelector(".rp-brand-mark");
  mark?.addEventListener(
    "mouseenter",
    () => mark.classList.add("rp-brand-mark--revealed"),
    { once: true },
  );

  // openModal / closeModal / Escape-closes-all live in main.js so
  // they're available on every page (landing + home + future surfaces).

  // ── Social login dispatch ──────────────────────────────────────
  // Google is the only provider with a real OAuth flow today. The
  // others are visual placeholders — toast "coming soon" so the
  // intent is clear without breaking the demo composition.
  window.doLogin = (provider) => {
    if (provider === "Google") {
      location.href = "/api/auth/google/start";
      return;
    }
    toast.info(`${provider} sign-in isn't wired yet — only Google for now.`);
  };

  // ── Contact form send ──────────────────────────────────────────
  // No /api/contact endpoint yet — toast so the user knows the form
  // isn't a black hole. Wire to a real endpoint when the backlog
  // item for contact-us lands.
  window.doContact = () => {
    toast.info("Contact form isn't wired yet — email hello@redpash.com for now.");
  };

  // PWA install is owned by main.js (it captures `beforeinstallprompt`
  // at the shell level — see scripts/main.js). The Download CTA in
  // landing.html stays hidden until that event arms.

  // rpToggleTheme / rpSetTheme + theme restoration live in main.js.

  // ── i18n setLang (port of redpash-components Django/js/i18n.js) ──
  // Walk the I18N table, apply each row's translation by selector.
  // Languages other than en/fr toast "coming soon" and fall back to
  // English so the page stays usable.
  window.setLang = (lang) => {
    const supported = ["en", "fr"];
    if (!supported.includes(lang)) {
      toast.info(`${lang.toUpperCase()} translation isn't ready yet — falling back to English.`);
      lang = "en";
    }
    for (const row of I18N) {
      const val = row[lang] ?? row.en;
      document.querySelectorAll(row.sel).forEach((el) => {
        if (row.attr === "placeholder") el.placeholder = val;
        else if (row.html)              el.innerHTML   = val;
        else                            el.textContent = val;
      });
    }
    // Update the float-bar label (EN / FR / …) and active picker option.
    const label = document.getElementById("ld-lang-label");
    if (label) label.textContent = lang.toUpperCase();
    document.querySelectorAll(".rp-float-picker-opt[data-lang]").forEach((b) => {
      b.classList.toggle("active", b.dataset.lang === lang);
    });
    document.documentElement.lang = lang;
    try { localStorage.setItem("redpash-lang", lang); } catch {}
    // Refresh the typist's phrase array so cycling picks the new language.
    window.reloadTypistPhrases?.();
  };

  // ── Eyebrow typewriter (port of clarna-django/static/js/ui.js) ──
  // Types and deletes phrases inside #hero-typist on a loop. State
  // starts at "full phrase 0, deleting=true" so the first action
  // after the 1.8s warm-up is to erase the static first-paint text
  // and reveal the next phrase. reloadTypistPhrases lets setLang
  // swap the language array without restarting the page.
  const typistEl = root.querySelector("#hero-typist");
  if (typistEl) {
    const getLang = () => localStorage.getItem("redpash-lang") || "en";
    let phrases = window.__typistPhrases[getLang()] || window.__typistPhrases.en;
    let pi = 0;
    let ci = phrases[0].length;
    let deleting = true;
    function tick() {
      const phrase = phrases[pi];
      if (!deleting) {
        typistEl.textContent = phrase.slice(0, ++ci);
        if (ci === phrase.length) { deleting = true; setTimeout(tick, 2400); return; }
        setTimeout(tick, 52);
      } else {
        typistEl.textContent = phrase.slice(0, --ci);
        if (ci === 0) { deleting = false; pi = (pi + 1) % phrases.length; setTimeout(tick, 320); return; }
        setTimeout(tick, 26);
      }
    }
    setTimeout(tick, 1800);
    window.reloadTypistPhrases = () => {
      const next = window.__typistPhrases[getLang()] || window.__typistPhrases.en;
      if (next !== phrases) { phrases = next; pi = 0; ci = 0; deleting = false; }
    };
  }

  // Restore saved language on mount. We also kick reloadTypistPhrases
  // so a fresh phrase array gets picked up if the lang was non-EN.
  try {
    const saved = localStorage.getItem("redpash-lang") || "en";
    if (saved !== "en") window.setLang(saved);
  } catch {}
}
