// ============================================================
// SRE SQL bridge — lets the (closed-VNet) SRE Agent reach the
// private-endpoint Azure SQL server without VNet-injecting the agent.
//
// A VNet-integrated, container-based Azure Function exposes intent-based,
// function-key-protected endpoints (diagnose / kill) plus a 5-minute blocking
// snapshot timer. It authenticates to Azure SQL with its managed identity and
// resolves the SQL private endpoint via the VNet's private DNS zone.
//
// Inbound is locked to the agent egress IP via App Service access restrictions.
//
// NOTE on registry pull: this module pulls the container image with the
// Function's managed identity (AcrPull) — secret-free. (The live resource was
// originally created with ACR admin credentials; this is the hardened form.)
//
// NOTE on SQL grants: the managed identity also needs *data-plane* grants in
// SQL that cannot be expressed in ARM/Bicep:
//   - master:  CREATE LOGIN [<func>] FROM EXTERNAL PROVIDER;
//   - JBDB:    CREATE USER [<func>] FROM LOGIN [<func>];
//              GRANT VIEW DATABASE STATE      TO [<func>];  -- read blocking DMVs
//              GRANT KILL DATABASE CONNECTION TO [<func>];  -- terminate a session
// Run scripts/grant-sre-bridge-sql.mjs and scripts/grant-sre-bridge-jbdb.mjs
// (or the postdeploy hook) after provisioning.
// ============================================================
param location string
param tags object
param resourceToken string

@description('Resource ID of the delegated subnet for the Function VNet integration (snet-func).')
param funcSubnetId string

@description('FQDN of the Azure SQL logical server the bridge connects to.')
param sqlServerFqdn string

@description('Name of the database the bridge monitors/acts on (per-database DMVs + KILL).')
param sqlDatabaseName string

@description('App Insights connection string the bridge emits its snapshot telemetry to.')
param appInsightsConnectionString string

@description('Egress IP/CIDR of the SRE Agent. Only this source may call the bridge.')
param agentEgressIp string = '172.203.122.125/32'

@description('Container image repository name in the registry.')
param imageRepository string = 'sqlbridge'

@description('Container image tag. Build/push with: az acr build -r <acr> -t <repo>:<tag> ./functionapp')
param imageTag string = 'v2'

// Built-in role definition IDs.
var storageBlobDataOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var storageQueueDataContributorRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var storageTableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

// -------------------- Storage (Functions runtime + secret store, identity-based) --------------------
// Shared-key auth is disabled, so AzureWebJobsStorage uses an identity-based
// connection (the Function MI holds the data-plane roles below).
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stfunc${resourceToken}'
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
  }
}

// -------------------- Container registry (holds the bridge image) --------------------
resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  #disable-next-line BCP334 // resourceToken is always >= 12 chars in practice
  name: 'acr${resourceToken}'
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

// -------------------- Isolated Basic Linux plan (keeps off the web app's plan) --------------------
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'plan-func-${resourceToken}'
  location: location
  tags: tags
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

// -------------------- Function App (container, VNet integrated, MI auth) --------------------
resource funcApp 'Microsoft.Web/sites@2023-12-01' = {
  name: 'func-sqlbridge-${resourceToken}'
  location: location
  tags: tags
  kind: 'functionapp,linux,container'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    virtualNetworkSubnetId: funcSubnetId
    siteConfig: {
      linuxFxVersion: 'DOCKER|${acr.properties.loginServer}/${imageRepository}:${imageTag}'
      acrUseManagedIdentityCreds: true
      alwaysOn: true
      ftpsState: 'Disabled'
      vnetRouteAllEnabled: true
      ipSecurityRestrictions: [
        {
          name: 'allow-sre-agent'
          action: 'Allow'
          priority: 100
          ipAddress: agentEgressIp
        }
        {
          name: 'Deny all'
          action: 'Deny'
          priority: 2147483647
          ipAddress: 'Any'
        }
      ]
      appSettings: [
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE'
          value: 'false'
        }
        {
          name: 'AzureWebJobsStorage__accountName'
          value: storage.name
        }
        {
          name: 'AzureWebJobsStorage__credential'
          value: 'managedidentity'
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsightsConnectionString
        }
        {
          name: 'WEBSITE_DNS_SERVER'
          value: '168.63.129.16'
        }
        {
          name: 'SQL_SERVER'
          value: sqlServerFqdn
        }
        {
          name: 'SQL_DB'
          value: sqlDatabaseName
        }
      ]
    }
  }
}

// -------------------- Role assignments for the Function MI --------------------
// Identity-based AzureWebJobsStorage (runtime + encrypted secret/key store).
resource blobOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, funcApp.id, storageBlobDataOwnerRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataOwnerRoleId)
    principalId: funcApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource queueContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, funcApp.id, storageQueueDataContributorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageQueueDataContributorRoleId)
    principalId: funcApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource tableContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, funcApp.id, storageTableDataContributorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRoleId)
    principalId: funcApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Pull the container image with the Function MI (secret-free registry access).
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, funcApp.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: funcApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output functionAppName string = funcApp.name
output functionAppHostName string = funcApp.properties.defaultHostName
output functionPrincipalId string = funcApp.identity.principalId
output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output storageAccountName string = storage.name
