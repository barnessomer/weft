const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const layout = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body><main>${body}</main></body></html>`;

export function loginPage(error?: string): string {
  return layout(
    "Sign in",
    `<h1>Sign in</h1>${error ? `<p role="alert">${escape(error)}</p>` : ""}` +
      `<form method="post" action="/api/login"><label>Email <input name="email" type="email" required></label>` +
      `<label>Password <input name="password" type="password" required></label><button>Sign in</button></form>`,
  );
}

export function accountPage(user: { email: string; name: string }): string {
  return layout("Your account", `<h1>Hello, ${escape(user.name)}</h1><p>Signed in as ${escape(user.email)}.</p><form method="post" action="/api/logout"><button>Sign out</button></form>`);
}
