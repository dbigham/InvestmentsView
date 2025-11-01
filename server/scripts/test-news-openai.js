#!/usr/bin/env node
/*
  Quick CLI to exercise the OpenAI Responses call used by /api/news.
  Usage:
    node scripts/test-news-openai.js --symbols TSLA,NVDA,NVO --label "Aggressive RRSP Core"
*/

const OpenAI = require('openai');
require('dotenv').config();

function parseArgs(argv) {
  const out = { symbols: [], label: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--symbols' && argv[i + 1]) {
      out.symbols = String(argv[++i])
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (arg === '--label' && argv[i + 1]) {
      out.label = String(argv[++i]).trim();
      continue;
    }
  }
  return out;
}

async function main() {
  const { symbols, label } = parseArgs(process.argv);
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    console.error('Missing OPENAI_API_KEY');
    process.exit(2);
  }
  if (!symbols.length) {
    console.error('Provide --symbols CSV');
    process.exit(2);
  }

  const model = process.env.OPENAI_NEWS_MODEL || 'gpt-4o-mini';
  const client = new OpenAI({ apiKey });

  const structuredTextFormat = {
    type: 'json_schema',
    name: 'portfolio_news',
    schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          articles: {
            type: 'array',
            maxItems: 8,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'url', 'summary', 'source', 'publishedAt'],
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
                summary: { type: 'string' },
                source: { type: 'string' },
                publishedAt: { type: 'string' },
              },
            },
          },
          disclaimer: { type: 'string' },
        },
        required: ['articles', 'disclaimer'],
      },
  };

  const baseRequest = {
    model,
    max_output_tokens: 1100,
    // Start without tools to reduce surface area; you can set
    // OPENAI_NEWS_TOOLS=web_search to enable it if supported.
    instructions:
      'You are a portfolio research assistant. Respond ONLY with JSON matching the provided schema. '
      + 'Summarize recent news articles for the supplied tickers.',
    input: [
      `Account label: ${label || 'Portfolio'}`,
      `Stock symbols: ${symbols.join(', ')}`,
      'Task: Find up to eight relevant and timely news articles or notable posts published within the past 14 days that mention these tickers. Prioritize reputable financial publications, company announcements, and influential analysis.',
      'For each article provide the title, a direct URL, the publisher/source when available, the publication date (ISO 8601 preferred), and a concise summary under 60 words.',
    ].join('\n'),
  };

  try {
    const response = await client.responses.create({
      ...baseRequest,
      text: { format: structuredTextFormat },
    });
    const output = response.output_text || (Array.isArray(response.output) ? response.output[0]?.content?.[0]?.text : null);
    console.log('Raw output_text length:', output ? output.length : 0);
    if (!output) {
      console.error('No output_text in response');
      process.exit(3);
    }
    try {
      const parsed = JSON.parse(output);
      console.log(JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.error('Failed to parse JSON output:', e.message);
      console.log(output);
      process.exit(4);
    }
  } catch (err) {
    const status = err?.status || err?.code || null;
    console.error('OpenAI request failed', {
      status,
      message: err?.message,
      error: err?.error,
    });
    process.exit(1);
  }
}

main();
