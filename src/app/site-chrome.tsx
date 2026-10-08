export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="frame site-header-inner">
        <div className="brand-lockup">
          <div className="brand-row">
            <h1>Dietary guidance</h1>
            <span className="service-badge">Official Service</span>
          </div>
          <p>Answers from official public dietary guidance</p>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="frame site-footer-inner">
        <div>
          <p className="footer-title">Dietary guidance · Published sources only</p>
          <p>
            Answers come from four public guidance documents. This is not an
            individual medical assessment. For personal advice, consult a
            licensed practitioner.
          </p>
        </div>
      </div>
    </footer>
  );
}
