# PediatricRiskProfiler

An MCP server that connects to FHIR patient data and surfaces pediatric health 
risks that are easy to miss in a busy clinic sustained BMI trends, repeated 
elevated blood pressure, chronic infection progression, and recurring dental 
conditions.

Built for the [Agents Assemble: The Healthcare AI Endgame](https://agentsassemble.devpost.com) 
hackathon on the Prompt Opinion platform.

## The problem it solves

Clinicians seeing dozens of patients a day rarely have time to look back at 
years of historical data. A child's BMI quietly climbing into the overweight 
range over 6 years, blood pressure elevated on every single visit, an ear 
infection that progressed into chronic sinusitis these patterns exist in the 
data but take time to find manually.

PediatricRiskProfiler gives any AI agent instant access to structured risk 
summaries across four health domains, directly from FHIR data, in a single 
tool call.

## Built with

- TypeScript, Node.js, Express
- MCP SDK (`@modelcontextprotocol/sdk`)
- FHIR R4 (`@smile-cdr/fhirts`)
- Prompt Opinion Platform + SHARP extension
- Docker, Render

## Tools

| Tool | Description |
|------|-------------|
| `GetGrowthRiskSummary` | BMI percentile history with overweight/obese flags and latest height/weight |
| `GetBPTrend` | Blood pressure readings over time, flags systolic > 130 as elevated |
| `GetPediatricRiskFlags` | Combines BMI + BP data to produce overall LOW/MODERATE/HIGH cardiovascular risk score |
| `GetRespiratoryConditionChain` | Chronological chain of respiratory conditions with duration and active flags |
| `GetRespiratoryRiskSummary` | Detects chronic progression, recurrence gaps, and rapid re-infection patterns |
| `GetOralHealthTimeline` | Chronological dental condition history with recurrence detection |
| `GetOralHealthRiskSummary` | Identifies recurring dental conditions, clusters, and linked episodes with risk scoring |

## Folder structure

```
typescript/
├── tools/
│   ├── GetBPTrend.ts
│   ├── GetGrowthRiskSummary.ts
│   ├── GetOralHealthRiskSummary.ts
│   ├── GetOralHealthTimeline.ts
│   ├── GetPediatricRiskFlags.ts
│   ├── GetRespiratoryConditionChain.ts
│   ├── GetRespiratoryRiskSummary.ts
│   ├── PatientAgeTool.ts
│   ├── PatientIdTool.ts
│   └── index.ts
├── fhir-client.ts
├── fhir-utilities.ts
├── fhir-context.ts
├── mcp-utilities.ts
├── null-utilities.ts
├── IMcpTool.ts
├── index.ts
├── Dockerfile
└── package.json
```

## Prerequisites

- Node.js 20+
- A [Prompt Opinion](https://app.promptopinion.ai) account
- A Google Gemini API key (for the agent model)
- [ngrok](https://ngrok.com) for local development

## Running locally

1. Clone the repo

```bash
git clone https://github.com/parthodas23/PatientRiskProfiler.git
cd PatientRiskProfiler/typescript
```

2. Install dependencies

```bash
npm install
```

3. Start the server

```bash
npm start
```

4. Expose it with ngrok

```bash
ngrok http 5000
```

5. Copy the ngrok URL and add `/mcp` at the end

```
https://your-ngrok-url.ngrok-free.app/mcp
```

## Connecting to Prompt Opinion

1. Go to **Configuration → MCP Servers** in your Prompt Opinion workspace
2. Click **Add MCP Server**
3. Paste your `/mcp` endpoint URL
4. Set Transport Type to **Streamable HTTP**
5. Check **Pass FHIR Context** to enable patient data access
6. Click **Test** you should see all 7 tools listed
7. Click **Save**

## Deploying to Render

1. Push your code to GitHub
2. Create a new **Web Service** on [Render](https://render.com)
3. Connect your GitHub repo
4. Set **Dockerfile Path** to `typescript/Dockerfile`
5. Leave **Root Directory** empty
6. Deploy your public MCP endpoint will be:

```
https://your-service-name.onrender.com/mcp
```

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PO_ENV` | Set to `dev` or `prod` for Prompt Opinion hosted environments | `localhost` |
| `PORT` | Port the server listens on | `5000` |

## License

ISC