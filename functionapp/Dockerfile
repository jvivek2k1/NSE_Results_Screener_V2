# Container image for the SQL bridge Function.
# The Azure Functions python:4 base image already ships the Microsoft ODBC
# Driver 18, so pyodbc + managed-identity auth works without extra apt packages.
FROM mcr.microsoft.com/azure-functions/python:4-python3.11

ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true \
    PIP_PROGRESS_BAR=off \
    PIP_NO_COLOR=1

COPY requirements.txt /
RUN pip install --no-cache-dir -r /requirements.txt

COPY . /home/site/wwwroot
