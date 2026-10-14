export function BrandLockup() {
  return (
    <div className="brand">
      <div className="brand-copy">
        <h1>Dietary Guidance Assistant</h1>
        <p>Evidence, made easier to understand.</p>
      </div>
    </div>
  );
}

const HOW_STEPS = [
  {
    index: "01",
    title: "Ask a question",
    body: "Ask about everyday dietary guidance or food safety.",
  },
  {
    index: "02",
    title: "Find relevant guidance",
    body: "The system searches approved public documents for passages related to the question.",
  },
  {
    index: "03",
    title: "Get a cited answer",
    body: "The assistant summarizes relevant evidence and links claims to supporting sources.",
  },
  {
    index: "04",
    title: "Check the evidence",
    body: "Open the citations to verify the original guidance. If the available evidence is insufficient, the assistant should say so rather than guess.",
  },
] as const;

export function HowItWorks({ onViewSources }: { onViewSources: () => void }) {
  return (
    <div className="works-copy">
      <ol className="works-steps">
        {HOW_STEPS.map((step) => (
          <li key={step.index}>
            <h3>
              <span className="works-index">{step.index}</span>
              <span className="works-dash" aria-hidden="true">
                {" "}
                —{" "}
              </span>
              {step.title}
            </h3>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
      <p className="works-limit">
        This assistant provides general dietary and food-safety guidance, not
        personalized calorie targets, weight recommendations, or medical advice.
      </p>
      <button type="button" className="works-sources" onClick={onViewSources}>
        View all sources
      </button>
    </div>
  );
}

export function AboutAssistant() {
  return (
    <section className="about" aria-labelledby="about-title">
      <h2 id="about-title">About this assistant</h2>
      <p>
        Provides general dietary guidance and food safety information from official
        sources.
      </p>
      <p>
        It does not provide personalized calorie targets, weight recommendations, or
        medical advice.
      </p>
    </section>
  );
}
