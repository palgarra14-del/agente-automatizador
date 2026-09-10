console.log(JSON.stringify({
  pathAvailable: Boolean(process.env.PATH),
  credentials: {
    github: process.env.GITHUB_TOKEN !== undefined,
    vercel: process.env.VERCEL_TOKEN !== undefined,
    openai: process.env.OPENAI_API_KEY !== undefined,
    codex: process.env.CODEX_API_KEY !== undefined
  }
}));
