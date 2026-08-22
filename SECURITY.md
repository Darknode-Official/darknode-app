# Scope, ethics, and responsible use

Sentinel packages security tooling — port scanning, payload/reverse-shell
generators, recon utilities, and links to offensive tools — into one console.
That is powerful, and it comes with responsibility.

## The one hard rule

**Only use Sentinel against systems you own or have explicit, written permission
to test.** Unauthorized scanning, exploitation, or access is illegal in most
places and can cause real harm.

## Ground rules

- **Authorization first.** A signed scope or written permission before any active
  testing — scanning, brute-forcing, or exploitation.
- **Stay in scope.** Touch only the hosts, ports, and applications you were
  authorized to test.
- **Minimize impact.** Prefer non-destructive techniques. No denial-of-service, no
  data destruction.
- **Protect what you find.** Handle credentials, PII, and findings securely; report
  and delete responsibly.
- **Know the law.** You are responsible for complying with the laws that apply to
  you and your target.

## No target? Practice legally

Use purpose-built labs instead of live systems:
[TryHackMe](https://tryhackme.com/) · [Hack The Box](https://www.hackthebox.com/) ·
[PortSwigger Web Security Academy](https://portswigger.net/web-security) ·
[OWASP](https://owasp.org/)

## Reporting a problem

Found a security issue in Sentinel itself? Contact the maintainer privately rather
than filing a public issue with exploit details.

---

*This is a personal learning project built by a student, provided as-is with no warranty. The author is not responsible for misuse. Use it to
learn, to defend, and to test only what you are allowed to test.*
