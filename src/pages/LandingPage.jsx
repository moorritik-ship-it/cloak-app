import { Link } from 'react-router-dom'
import { MailCheck, Shuffle, MessageCircle, Lock, School, ShieldCheck } from 'lucide-react'
import ScrollReveal from '../components/ScrollReveal'

function LandingPage() {
  const particles = Array.from({ length: 18 }, (_, index) => ({
    id: index,
    size: 4 + ((index * 3) % 8),
    left: `${(index * 13) % 100}%`,
    delay: `${(index % 6) * 0.6}s`,
    duration: `${8 + (index % 5) * 2}s`,
  }))

  return (
    <main className="landing-page w-full min-w-0 max-w-[100vw] overflow-x-hidden text-base sm:text-[1.02rem]">
      <section className="hero">
        <div className="particles" aria-hidden="true">
          {particles.map((particle) => (
            <span
              key={particle.id}
              className="particle"
              style={{
                width: `${particle.size}px`,
                height: `${particle.size}px`,
                left: particle.left,
                animationDelay: particle.delay,
                animationDuration: particle.duration,
              }}
            />
          ))}
        </div>

        <div className="hero-content">
          <p className="badge">College-Exclusive Anonymous Video Chat</p>
          <h1>CLOAK</h1>
          <p className="tagline">Speak freely, safely with your own people</p>
          <div className="cta-group">
            <Link to="/login" className="cta-button cta-primary">
              Get Started with Your College Email
            </Link>
            <button className="cta-button cta-secondary" type="button">
              Join Your College Community
            </button>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>How It Works</h2>
        <div className="card-grid">
          <ScrollReveal className="scroll-reveal-card">
            <article className="card">
              <div className="icon-wrap">
                <MailCheck size={22} />
              </div>
              <h3>Verify Email</h3>
              <p>Sign in with your college email to unlock your verified campus network.</p>
            </article>
          </ScrollReveal>
          <ScrollReveal className="scroll-reveal-card">
            <article className="card">
              <div className="icon-wrap">
                <Shuffle size={22} />
              </div>
              <h3>Match Instantly</h3>
              <p>Get paired in seconds with real students from your own college community.</p>
            </article>
          </ScrollReveal>
          <ScrollReveal className="scroll-reveal-card">
            <article className="card">
              <div className="icon-wrap">
                <MessageCircle size={22} />
              </div>
              <h3>Chat Freely</h3>
              <p>Have honest, anonymous face-to-face conversations with total confidence.</p>
            </article>
          </ScrollReveal>
        </div>
      </section>

      <section className="section">
        <h2>Privacy First, Always</h2>
        <div className="privacy-grid">
          <ScrollReveal className="scroll-reveal-card">
            <article className="privacy-card">
              <div className="icon-wrap">
                <Lock size={22} />
              </div>
              <h3>End-to-End Encryption</h3>
              <p>
                Every call is encrypted from device to device so only you and your match can
                access the conversation.
              </p>
            </article>
          </ScrollReveal>
          <ScrollReveal className="scroll-reveal-card">
            <article className="privacy-card">
              <div className="icon-wrap">
                <School size={22} />
              </div>
              <h3>College-Only Access</h3>
              <p>
                CLOAK is restricted to verified .edu users, keeping conversations within your
                trusted student ecosystem.
              </p>
            </article>
          </ScrollReveal>
          <ScrollReveal className="scroll-reveal-card">
            <article className="privacy-card">
              <div className="icon-wrap">
                <ShieldCheck size={22} />
              </div>
              <h3>Anonymous by Design</h3>
              <p>
                No public profile details are required, so you can speak your mind without
                social pressure.
              </p>
            </article>
          </ScrollReveal>
        </div>
      </section>

      <footer className="footer">
        <a href="#">Privacy Policy</a>
        <a href="#">Terms of Service</a>
        <a href="#">Community Guidelines</a>
      </footer>
    </main>
  )
}

export default LandingPage
