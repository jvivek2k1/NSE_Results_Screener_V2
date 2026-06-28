// ============================================================
// Grant the App Service managed identity the management-plane roles needed by
// the SRE chaos demo:
//   • SQL Server Contributor        — toggle the SQL server's public network
//                                     access ("Disable SQL Public Access").
//   • Cognitive Services Contributor — delete the model deployment
//                                     ("Remove AI Model").
// Scoped narrowly to the specific SQL server and AI account.
// ============================================================
param sqlServerName string
param aiAccountName string

@description('Principal (object) ID of the App Service managed identity.')
param principalId string

// SQL Server Contributor
var sqlServerContributorRoleId = '6d8ee4ec-f05a-4a1d-8b00-a9b17e38b437'
// Cognitive Services Contributor
var cognitiveServicesContributorRoleId = '25fbc0a9-bd7c-42a3-aa1a-3b75d497ee68'

resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' existing = {
  name: sqlServerName
}

resource aiAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: aiAccountName
}

resource sqlContributorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sqlServer
  name: guid(sqlServer.id, principalId, sqlServerContributorRoleId)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', sqlServerContributorRoleId)
  }
}

resource aiContributorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: aiAccount
  name: guid(aiAccount.id, principalId, cognitiveServicesContributorRoleId)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesContributorRoleId)
  }
}
