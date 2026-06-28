// ============================================================
// App Service: Linux plan + web app (Node 20), system-assigned identity,
// regional VNet integration, and inbound access restricted to the
// Application Gateway subnet (secure baseline).
// ============================================================
param location string
param tags object
param resourceToken string
param serviceName string = 'web'

param appSubnetId string
param appGatewaySubnetId string
param appInsightsConnectionString string
param sqlServerFqdn string
param sqlDatabaseName string
param aiEndpoint string
param aiDeploymentName string
param aiApiVersion string

@description('Subscription ID — used by the SRE chaos demo (management plane).')
param subscriptionId string = ''
@description('Resource group name — used by the SRE chaos demo (management plane).')
param resourceGroupName string = ''
@description('SQL logical server short name — used by the SRE chaos demo.')
param sqlServerName string = ''
@description('Azure AI Services account short name — used by the SRE chaos demo.')
param aiAccountName string = ''

@description('Key Vault name backing the EMAIL_APP_PASSWORD reference.')
param keyVaultName string = ''
@description('When "true", email-on-open settings are added to the app.')
param emailEnabled string = 'false'
param emailHost string = ''
param emailPort string = '465'
param emailUser string = ''
param emailFrom string = ''
param emailTo string = ''
param emailThrottleMinutes string = '10'
param emailPasswordSecretName string = 'EMAIL-APP-PASSWORD'

var emailOn = toLower(emailEnabled) == 'true'
var emailAppSettings = emailOn ? [
  { name: 'EMAIL_HOST', value: emailHost }
  { name: 'EMAIL_PORT', value: emailPort }
  { name: 'EMAIL_USER', value: emailUser }
  { name: 'EMAIL_FROM', value: empty(emailFrom) ? emailUser : emailFrom }
  { name: 'EMAIL_TO', value: empty(emailTo) ? emailUser : emailTo }
  { name: 'EMAIL_THROTTLE_MINUTES', value: emailThrottleMinutes }
  { name: 'EMAIL_APP_PASSWORD', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=${emailPasswordSecretName})' }
] : []

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'plan-${resourceToken}'
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: 'P1v3'
    tier: 'PremiumV3'
  }
  properties: {
    reserved: true
  }
}

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: 'app-${resourceToken}'
  location: location
  kind: 'app,linux'
  tags: union(tags, { 'azd-service-name': serviceName })
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    virtualNetworkSubnetId: appSubnetId
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      vnetRouteAllEnabled: false
      healthCheckPath: '/api/health'
      appCommandLine: 'node server.js'
      // Restrict inbound traffic to the Application Gateway subnet only.
      ipSecurityRestrictions: [
        {
          vnetSubnetResourceId: appGatewaySubnetId
          action: 'Allow'
          priority: 100
          name: 'Allow-AppGateway-Subnet'
        }
      ]
      ipSecurityRestrictionsDefaultAction: 'Deny'
      scmIpSecurityRestrictionsUseMain: false
      appSettings: concat([
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
        { name: 'ENABLE_ORYX_BUILD', value: 'true' }
        { name: 'WEBSITES_CONTAINER_START_TIME_LIMIT', value: '600' }
        { name: 'NODE_ENV', value: 'production' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
        { name: 'ApplicationInsightsAgent_EXTENSION_VERSION', value: '~3' }
        { name: 'XDT_MicrosoftApplicationInsights_Mode', value: 'recommended' }
        { name: 'DB_BACKEND', value: 'azure-sql' }
        { name: 'DATA_MODE', value: 'live' }
        { name: 'AZURE_SQL_SERVER', value: sqlServerFqdn }
        { name: 'AZURE_SQL_DATABASE', value: sqlDatabaseName }
        { name: 'AZURE_OPENAI_ENDPOINT', value: aiEndpoint }
        { name: 'AZURE_OPENAI_DEPLOYMENT', value: aiDeploymentName }
        { name: 'AZURE_OPENAI_API_VERSION', value: aiApiVersion }
        { name: 'AI_READ_PDF', value: 'true' }
        { name: 'FILING_MAX_REPORTING_LAG_DAYS', value: '90' }
        // SRE chaos demo — Azure resource coordinates for management-plane actions.
        { name: 'AZURE_SUBSCRIPTION_ID', value: subscriptionId }
        { name: 'AZURE_RESOURCE_GROUP', value: resourceGroupName }
        { name: 'AZURE_SQL_SERVER_NAME', value: sqlServerName }
        { name: 'AZURE_AI_ACCOUNT_NAME', value: aiAccountName }
        // SRE chaos demo — "SQL CPU 100%" tuning. The untuned report runs
        // continuously (CHAOS_CPU_SECONDS=0) with enough parallelism to peg the
        // serverless vCores while leaving pool connections free for the app's
        // own health/data queries. CPU stays at ~100% until the SRE Agent
        // remediates it (adding the covering index makes the scans cheap).
        { name: 'CHAOS_CPU_SECONDS', value: '0' }
        { name: 'CHAOS_CPU_PARALLELISM', value: '4' }
        { name: 'CHAOS_CPU_ITERATIONS', value: '50' }
        { name: 'CHAOS_ORDERS_ROWS', value: '2000000' }
      ], emailAppSettings)
    }
  }
}

output appName string = webApp.name
output appHostName string = webApp.properties.defaultHostName
output appPrincipalId string = webApp.identity.principalId
output appResourceId string = webApp.id
