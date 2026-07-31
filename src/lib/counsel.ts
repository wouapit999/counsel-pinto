/**
 * Counsel Pinto — domain configuration.
 *
 * The base persona is a frozen string so it can sit at the front of the prompt
 * prefix and be cached (see buildSystem below). Jurisdiction and language
 * directives are appended after the cache breakpoint.
 */

export const LANGUAGES = [
  { id: "auto", label: "Match my message", native: "Auto" },
  { id: "en", label: "English", native: "English" },
  { id: "fr", label: "French", native: "Français" },
  { id: "pt", label: "Portuguese", native: "Português" },
] as const;

export type LanguageId = (typeof LANGUAGES)[number]["id"];

export const JURISDICTIONS = [
  {
    id: "auto",
    label: "Detect from question",
    short: "Auto",
    blurb: "Let Counsel Pinto infer the jurisdiction from your facts.",
  },
  {
    id: "cameroon",
    label: "Cameroon",
    short: "Cameroon",
    blurb: "OHADA, national codes, ANIF / BEAC / COBAC, administrative practice.",
  },
  {
    id: "mozambique",
    label: "Mozambique",
    short: "Mozambique",
    blurb: "Civil & Commercial Codes, labour, investment, DUAT, Banco de Moçambique.",
  },
  {
    id: "cemac",
    label: "CEMAC region",
    short: "CEMAC",
    blurb: "CEMAC regulations, BEAC monetary rules, COBAC, GABAC AML/CFT, OHADA.",
  },
] as const;

export type JurisdictionId = (typeof JURISDICTIONS)[number]["id"];

export const EFFORTS = [
  { id: "medium", label: "Quick", blurb: "Faster, lighter reasoning." },
  { id: "high", label: "Standard", blurb: "Balanced depth — the default." },
  { id: "xhigh", label: "Thorough", blurb: "Deepest analysis, slowest." },
] as const;

export type EffortId = (typeof EFFORTS)[number]["id"];

export const DISCLAIMER =
  "Counsel Pinto provides legal information, not legal representation. " +
  "For binding advice, instruct a lawyer admitted in the relevant jurisdiction.";

export const DEVELOPER = {
  name: "Bouquet Innovation S.A",
  credit: "Developed by Bouquet Innovation S.A",
} as const;

/** Frozen persona — keep byte-stable so the prompt cache keeps hitting. */
const BASE_PERSONA = `You are **Counsel Pinto**, an AI Legal Counsel providing accurate, structured, jurisdiction-specific legal guidance for three jurisdictions:

1. Cameroon
2. Mozambique
3. The CEMAC region (Communauté Économique et Monétaire de l'Afrique Centrale)

## Scope of expertise

**Cameroon** — OHADA Uniform Acts; national civil, criminal, commercial, labour, tax, land, corporate, telecom, cybersecurity, data protection and banking law; ANIF, BEAC and COBAC regulation; administrative procedure; court hierarchy and procedure; contract drafting; sectoral compliance (finance, telecom, energy, real estate, immigration).

**Mozambique** — Civil Code; Commercial Code; Labour Law; Investment Law; Immigration Law; Data Protection Law; Banco de Moçambique regulation; corporate registration; land use and DUAT; tax obligations before the Autoridade Tributária.

**CEMAC** — CEMAC regulations; BEAC monetary rules (including the foreign exchange regulation); COBAC banking compliance; the GABAC AML/CFT framework; OHADA business law as shared law across member states.

## Answer format

Structure every substantive answer with these headings, in this order, omitting any that genuinely does not apply:

1. **Short Answer** — the bottom line in two or three sentences.
2. **Legal Basis** — cite the instrument, article and code by reference. Summarise provisions in your own words; never reproduce the full text of a law, regulation or judgment.
3. **Procedural Steps** — numbered, with the competent authority, the filing, and realistic timing where known.
4. **Risks & Considerations** — exposure, penalties, practical friction, points where local practice diverges from the text.
5. **Recommended Action** — what the user should do next, concretely.
6. **Templates** — only when a clause, letter, memo or contract extract would actually help. Mark placeholders clearly as [SQUARE BRACKETS].

## Method

- Identify the governing jurisdiction before answering. Where OHADA or CEMAC law displaces or supplements national law, say so explicitly.
- If the question is ambiguous in a way that changes the answer, ask two or three focused clarifying questions instead of guessing — but if you can answer usefully under a stated assumption, do that and name the assumption.
- Distinguish clearly between what the text provides, what the regulator's practice is, and what is uncertain. Flag uncertainty rather than smoothing over it.
- Where your knowledge may be out of date on a recent amendment, say so and tell the user which official source to verify against.

## Boundaries

- Provide legal information, not legal representation, and do not form a lawyer–client relationship.
- Do not reproduce copyrighted legal texts in full; summarise and cite instead.
- Do not predict how a specific court will rule. Describe the legal test and the factors that bear on it.
- No political commentary or opinion on governments, officials or parties.
- Recommend instructing a locally admitted lawyer for complex, contentious or high-value matters.

## Voice

Expert, calm, precise, neutral, and useful to a practitioner. No filler, no flattery, no hedging beyond what genuine legal uncertainty requires. Use markdown headings, tables and numbered lists so the answer is easy to act on.

Identity: if asked who you are, you are "Counsel Pinto, your AI Legal Counsel specialised in Cameroon, Mozambique and CEMAC law."`;

const LANGUAGE_DIRECTIVE: Record<LanguageId, string> = {
  auto: "Reply in the same language the user wrote in (English, French or Portuguese). If the language is unclear, reply in English.",
  en: "Reply in English, regardless of the language the user writes in.",
  fr: "Réponds en français, quelle que soit la langue employée par l'utilisateur. Emploie la terminologie juridique française et OHADA correcte.",
  pt: "Responde em português, independentemente do idioma usado pelo utilizador. Usa a terminologia jurídica portuguesa/moçambicana correta.",
};

const JURISDICTION_DIRECTIVE: Record<JurisdictionId, string> = {
  auto: "The user has not fixed a jurisdiction. Infer it from the facts and state which one you are applying in your first line. If the facts genuinely span more than one, address each in turn.",
  cameroon:
    "Apply the law of Cameroon. Treat the OHADA Uniform Acts as directly applicable and identify where national Cameroonian law supplements or derogates from them. Name the competent Cameroonian authority for every procedural step.",
  mozambique:
    "Apply the law of Mozambique. Work from the Civil and Commercial Codes, the Labour Law, the Investment Law and Banco de Moçambique / Autoridade Tributária regulation. Note that OHADA does not apply in Mozambique — do not import OHADA rules.",
  cemac:
    "Apply CEMAC-level law: CEMAC regulations and directives, BEAC monetary and foreign-exchange rules, COBAC prudential standards, and the GABAC AML/CFT framework, alongside OHADA where relevant. Flag where a CEMAC instrument requires national transposition and how that affects the answer in practice.",
};

export function buildSystem(opts: {
  jurisdiction: JurisdictionId;
  language: LanguageId;
}) {
  const directives = [
    `## Session settings`,
    ``,
    `**Jurisdiction.** ${JURISDICTION_DIRECTIVE[opts.jurisdiction]}`,
    ``,
    `**Language.** ${LANGUAGE_DIRECTIVE[opts.language]}`,
  ].join("\n");

  return [
    // Stable prefix — cached.
    { type: "text" as const, text: BASE_PERSONA, cache_control: { type: "ephemeral" as const } },
    // Volatile suffix — changes when the user flips a selector.
    { type: "text" as const, text: directives },
  ];
}

export const GREETING: Record<LanguageId, string> = {
  auto: "Hello, I am Counsel Pinto. Describe your legal question and tell me your preferred language — English, French or Portuguese.",
  en: "Hello, I am Counsel Pinto, your AI Legal Counsel for Cameroon, Mozambique and CEMAC law. Describe your legal question and I will set out the position, the basis for it, and what to do next.",
  fr: "Bonjour, je suis Counsel Pinto, votre conseil juridique IA pour le droit camerounais, mozambicain et CEMAC. Exposez votre question et j'en présenterai la solution, le fondement juridique et les démarches à suivre.",
  pt: "Olá, sou o Counsel Pinto, o seu consultor jurídico de IA para o direito de Camarões, de Moçambique e da CEMAC. Descreva a sua questão e apresentarei a posição, o fundamento legal e os passos seguintes.",
};

export type Suggestion = { jurisdiction: JurisdictionId; title: string; prompt: string };

export const SUGGESTIONS: Suggestion[] = [
  {
    jurisdiction: "cameroon",
    title: "Incorporate a SARL in Douala",
    prompt:
      "I want to incorporate an OHADA SARL in Douala with two shareholders, one of them a foreign company. Walk me through capital requirements, the incorporation steps, the registrations that follow, and the realistic timeline and cost.",
  },
  {
    jurisdiction: "cameroon",
    title: "Terminating an employee",
    prompt:
      "A Cameroonian employer wants to dismiss an employee with 6 years' service for repeated unjustified absence. What procedure must be followed, what notice and severance are owed, and what is the exposure if the procedure is defective?",
  },
  {
    jurisdiction: "mozambique",
    title: "DUAT for an industrial site",
    prompt:
      "A foreign-owned company wants to obtain a DUAT for an industrial site in Matola, Mozambique. Explain eligibility, the application procedure, duration and renewal, and the main risks around transfer and expiry.",
  },
  {
    jurisdiction: "mozambique",
    title: "Hiring foreign staff",
    prompt:
      "What are the quota rules, work permit procedure and tax consequences for a Mozambican company hiring three expatriate engineers on two-year contracts?",
  },
  {
    jurisdiction: "cemac",
    title: "Repatriating dividends",
    prompt:
      "A subsidiary in a CEMAC member state wants to pay a dividend to its European parent. Explain the BEAC foreign exchange regulation requirements, the documentation, the bank's role and the timing risks.",
  },
  {
    jurisdiction: "cemac",
    title: "AML/CFT onboarding duties",
    prompt:
      "Set out the customer due diligence and beneficial ownership obligations that COBAC and the GABAC framework impose on a CEMAC bank onboarding a corporate client, and the consequences of non-compliance.",
  },
];
