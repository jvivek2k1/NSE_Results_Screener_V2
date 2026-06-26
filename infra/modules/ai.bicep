// ============================================================
// Azure AI Services (Foundry) account + chat model deployment.
// Keyless (Entra-only) — the App Service managed identity is granted the
// "Cognitive Services OpenAI User" role on this account (see ai-access.bicep).
// The app calls the OpenAI-compatible /openai/v1/ surface on this endpoint.
// ============================================================
param aiLocation string
param tags object
param resourceToken string

@description('Name of the model deployment the app uses (AZURE_OPENAI_DEPLOYMENT).')
param deploymentName string

@description('Underlying model to deploy.')
param modelName string = 'gpt-4o'

@description('Model version.')
param modelVersion string = '2024-11-20'

@description('Deployment SKU name (GlobalStandard recommended for broad availability).')
param skuName string = 'GlobalStandard'

@description('Deployment capacity in thousands of tokens-per-minute.')
param capacity int = 10

var aiAccountName = 'nse-ai-${resourceToken}'

resource aiAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: aiAccountName
  location: aiLocation
  tags: tags
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    // Custom subdomain is required for Entra (AAD) token auth.
    customSubDomainName: aiAccountName
    publicNetworkAccess: 'Enabled'
    // Keyless only — no API keys are issued or used.
    disableLocalAuth: true
  }
}

resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aiAccount
  name: deploymentName
  sku: {
    name: skuName
    capacity: capacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
  }
}

output aiAccountName string = aiAccount.name
output aiAccountId string = aiAccount.id
output aiEndpoint string = aiAccount.properties.endpoint
