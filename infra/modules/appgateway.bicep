// ============================================================
// Application Gateway (WAF_v2) fronting the App Service, plus the
// "unhealthy backend" metric alert shown in the reference architecture.
// ============================================================
param location string
param tags object
param resourceToken string

param appGatewaySubnetId string
param publicIpId string
param wafPolicyId string
@description('Backend App Service default host name (app-xxxx.azurewebsites.net).')
param backendFqdn string
param actionGroupId string

var appGatewayName = 'agw-${resourceToken}'

// Self-referencing child resource IDs (App Gateway references its own parts by ID).
var gatewayId = resourceId('Microsoft.Network/applicationGateways', appGatewayName)
var frontendIpName = 'appGwPublicFrontendIp'
var frontendPortName = 'port_80'
var backendPoolName = 'appServiceBackendPool'
var httpSettingName = 'appServiceHttpsSetting'
var listenerName = 'httpListener'
var probeName = 'appServiceHealthProbe'
var routingRuleName = 'routingRule'

resource appGateway 'Microsoft.Network/applicationGateways@2023-11-01' = {
  name: appGatewayName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'WAF_v2'
      tier: 'WAF_v2'
    }
    autoscaleConfiguration: {
      minCapacity: 1
      maxCapacity: 2
    }
    gatewayIPConfigurations: [
      {
        name: 'appGatewayIpConfig'
        properties: {
          subnet: {
            id: appGatewaySubnetId
          }
        }
      }
    ]
    frontendIPConfigurations: [
      {
        name: frontendIpName
        properties: {
          publicIPAddress: {
            id: publicIpId
          }
        }
      }
    ]
    frontendPorts: [
      {
        name: frontendPortName
        properties: {
          port: 80
        }
      }
    ]
    backendAddressPools: [
      {
        name: backendPoolName
        properties: {
          backendAddresses: [
            {
              fqdn: backendFqdn
            }
          ]
        }
      }
    ]
    probes: [
      {
        name: probeName
        properties: {
          protocol: 'Https'
          path: '/api/health/ready'
          interval: 30
          timeout: 30
          unhealthyThreshold: 3
          pickHostNameFromBackendHttpSettings: true
          minServers: 0
          match: {
            statusCodes: [
              '200-399'
            ]
          }
        }
      }
    ]
    backendHttpSettingsCollection: [
      {
        name: httpSettingName
        properties: {
          port: 443
          protocol: 'Https'
          cookieBasedAffinity: 'Disabled'
          pickHostNameFromBackendAddress: true
          requestTimeout: 30
          probe: {
            id: '${gatewayId}/probes/${probeName}'
          }
        }
      }
    ]
    httpListeners: [
      {
        name: listenerName
        properties: {
          frontendIPConfiguration: {
            id: '${gatewayId}/frontendIPConfigurations/${frontendIpName}'
          }
          frontendPort: {
            id: '${gatewayId}/frontendPorts/${frontendPortName}'
          }
          protocol: 'Http'
        }
      }
    ]
    requestRoutingRules: [
      {
        name: routingRuleName
        properties: {
          ruleType: 'Basic'
          priority: 100
          httpListener: {
            id: '${gatewayId}/httpListeners/${listenerName}'
          }
          backendAddressPool: {
            id: '${gatewayId}/backendAddressPools/${backendPoolName}'
          }
          backendHttpSettings: {
            id: '${gatewayId}/backendHttpSettingsCollection/${httpSettingName}'
          }
        }
      }
    ]
    firewallPolicy: {
      id: wafPolicyId
    }
    forceFirewallPolicyAssociation: true
  }
}

// Metric alert: fires when the gateway sees any unhealthy backend host.
resource unhealthyBackendAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-appgw-unhealthy-backend'
  location: 'global'
  tags: tags
  properties: {
    description: 'Application Gateway has one or more unhealthy backend hosts.'
    severity: 2
    enabled: true
    scopes: [
      appGateway.id
    ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'UnhealthyHostCount'
          metricNamespace: 'Microsoft.Network/applicationGateways'
          metricName: 'UnhealthyHostCount'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    autoMitigate: true
    actions: [
      {
        actionGroupId: actionGroupId
      }
    ]
  }
}

output appGatewayName string = appGateway.name
output publicIpAddress string = reference(publicIpId, '2023-11-01').ipAddress
