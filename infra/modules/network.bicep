// ============================================================
// Networking: Virtual Network (App Gateway + App Service subnets),
// Public IP for the gateway, and the WAF policy.
// ============================================================
param location string
param tags object
param resourceToken string

var appGatewaySubnetName = 'snet-appgw'
var appSubnetName = 'snet-app'

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: 'vnet-${resourceToken}'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.0.0.0/16'
      ]
    }
    subnets: [
      {
        name: appGatewaySubnetName
        properties: {
          addressPrefix: '10.0.1.0/24'
          // Service endpoint so the App Service can restrict inbound traffic
          // to this subnet (the Application Gateway).
          serviceEndpoints: [
            {
              service: 'Microsoft.Web'
            }
          ]
        }
      }
      {
        name: appSubnetName
        properties: {
          addressPrefix: '10.0.2.0/24'
          // Delegated to App Service for regional VNet integration (outbound).
          delegations: [
            {
              name: 'webapp'
              properties: {
                serviceName: 'Microsoft.Web/serverFarms'
              }
            }
          ]
        }
      }
    ]
  }
}

resource publicIp 'Microsoft.Network/publicIPAddresses@2023-11-01' = {
  name: 'pip-${resourceToken}'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    dnsSettings: {
      domainNameLabel: 'nse-${resourceToken}'
    }
  }
}

resource wafPolicy 'Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies@2023-11-01' = {
  name: 'waf-${resourceToken}'
  location: location
  tags: tags
  properties: {
    policySettings: {
      state: 'Enabled'
      mode: 'Prevention'
      requestBodyCheck: true
      maxRequestBodySizeInKb: 128
      fileUploadLimitInMb: 100
    }
    managedRules: {
      managedRuleSets: [
        {
          ruleSetType: 'OWASP'
          ruleSetVersion: '3.2'
        }
      ]
    }
  }
}

output appGatewaySubnetId string = '${vnet.id}/subnets/${appGatewaySubnetName}'
output appSubnetId string = '${vnet.id}/subnets/${appSubnetName}'
output publicIpId string = publicIp.id
output wafPolicyId string = wafPolicy.id
