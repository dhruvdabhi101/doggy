# Security

Report a vulnerability through GitHub's private vulnerability advisories:

https://github.com/dhruvdabhi101/doggy/security/advisories/new

Do not open a public issue, pull request, or discussion for a security report.

Include what you found, the version or commit, and the steps that show the problem. Do not include other people's screen text, notes, or account data. A short synthetic example is enough.

The maintainer replies on the advisory. There is no paid bug bounty.

Doggy reads on-screen text. A report that the Mac or Windows agent reads a password field, an excluded app, or anything while capture is paused is in scope. So is a flaw that lets one account read another's data, or that sends secrets to the model provider when `server/src/redact.ts` should have caught that pattern.

Enable private vulnerability reporting in the repository settings if that link does not accept a report yet.
