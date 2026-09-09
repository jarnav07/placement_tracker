// Checks that the verification providers are actually reachable and usable:
//
//   npm run check:providers
//
// This exists because "the key is set" is not the same as "the key works". A
// Vertex AI key from a project without express mode, an AI Studio key pasted
// into the Vertex variable, a model that has been retired, a deployment name
// that does not match the Azure resource — each of those fails identically from
// the outside, as a nightly run that quietly verifies nothing.
//
// So each provider is exercised for real, cheaply: authentication, the Google
// Search grounding tool, and structured output for Gemini; one round trip for
// Azure. Total cost is a few hundred tokens.
//
// It touches no database and writes nothing.

import { pingGemini, describeBackend, geminiConfigured, geminiBackend, explainGeminiError } from './verify/gemini.mjs'
import { pingAzure, azureConfigured } from './verify/azure.mjs'

const HINTS = {
  vertex: [
    'Vertex AI needs an EXPRESS MODE key. A plain Google Cloud API key from a project',
    'without express mode is rejected even when the Vertex AI API is enabled.',
    '  - Get one at https://console.cloud.google.com/vertex-ai (sign up for express mode)',
    '  - Store it as the VERTEX_API_KEY secret',
    '  - Express mode takes no project id and no location: the endpoint is global',
    '  - An AI Studio key will NOT work here — use GEMINI_API_KEY for that instead',
  ],
  aistudio: [
    'AI Studio keys come from https://aistudio.google.com/apikey and go in GEMINI_API_KEY.',
    'A Vertex AI key will not work against this endpoint — use VERTEX_API_KEY for that.',
  ],
}

function report(label, result, details = []) {
  console.log(`\n${result.ok ? 'OK   ' : 'FAIL '} ${label}`)
  for (const line of details) console.log(`       ${line}`)
  for (const step of result.steps ?? []) {
    console.log(`       ${step.ok ? '✓' : '✗'} ${step.step}: ${step.detail}`)
  }
  if (!result.ok) console.log(`       error: ${result.error}`)
}

async function main() {
  console.log('Verification providers')
  console.log('======================')
  console.log(describeBackend())

  let failed = 0

  // --- Primary -------------------------------------------------------------
  if (!geminiConfigured) {
    console.log('\nFAIL  Primary verifier (Gemini) — no key configured')
    console.log('       Set VERTEX_API_KEY for Vertex AI, or GEMINI_API_KEY for AI Studio.')
    failed++
  } else {
    const gemini = await pingGemini()
    report(`Primary verifier — Gemini via ${gemini.backend === 'vertex' ? 'Vertex AI' : 'AI Studio'}`, gemini)
    if (!gemini.ok) {
      failed++
      // The API's own message first, then what it actually means.
      const explanation = explainGeminiError(gemini.error)
      if (explanation) console.log(`\n       ${explanation}`)
      console.log('')
      for (const line of HINTS[geminiBackend] ?? []) console.log(`       ${line}`)
    }
  }

  // --- Secondary -----------------------------------------------------------
  if (!azureConfigured) {
    console.log('\nWARN  Secondary verifier (Azure OpenAI) — not configured')
    console.log('       The pass still runs, but a role can no longer be marked Closed on')
    console.log('       two independent providers agreeing. Set AZURE_OPENAI_API_KEY,')
    console.log('       AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT_NAME to restore it.')
  } else {
    const azure = await pingAzure()
    report('Secondary verifier — Azure OpenAI', azure, azure.ok ? [`deployment: ${azure.deployment}`] : [])
    // The secondary is a second opinion, not a dependency: a failure here is
    // worth reporting loudly but is not a reason to fail the check.
    if (!azure.ok) {
      console.log('       Check AZURE_OPENAI_ENDPOINT (no trailing path) and that')
      console.log('       AZURE_OPENAI_DEPLOYMENT_NAME matches a deployment in that resource.')
    }
  }

  console.log('')
  if (failed) {
    console.error(`${failed} provider check failed. The nightly verification would not work as configured.`)
    process.exit(1)
  }
  console.log('Primary verifier is reachable and usable.')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
