// ============================================================
// Key Vault (RBAC-authorized) for application secrets.
// Stores the email app password as the secret EMAIL-APP-PASSWORD.
// The secret VALUE is written by the deploy script after provisioning
// (it is never placed in Bicep params or azd env files).
//
// Role assignments:
//   * App Service managed identity -> Key Vault Secrets User  (read at runtime)
//   * Deploying principal          -> Key Vault Secrets Officer (write the secret)
// ============================================================
param location string
param tags object
param resourceToken string

@description('Object ID of the App Service managed identity (runtime secret reader).')
param appPrincipalId string

@description('Object ID of the deploying principal (writes the secret post-provision).')
param deployerPrincipalId string

@allowed(['User', 'Group', 'Application'])
@description('Type of the deploying principal.')
param deployerPrincipalType string = 'User'

// Built-in role definition IDs.
var secretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'    // Key Vault Secrets User
var secretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7' // Key Vault Secrets Officer

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-${resourceToken}'
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

// App Service managed identity can READ secrets (used by the KV reference).
resource appReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, appPrincipalId, secretsUserRoleId)
  properties: {
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUserRoleId)
  }
}

// Deploying principal can WRITE the secret (the deploy script sets it).
resource deployerWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, deployerPrincipalId, secretsOfficerRoleId)
  properties: {
    principalId: deployerPrincipalId
    principalType: deployerPrincipalType
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsOfficerRoleId)
  }
}

output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
