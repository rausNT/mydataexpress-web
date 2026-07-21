{-------------------------------------------------------------------------------

    Portable extension provider bridge for DataExpress Web Server.
    Licensed under the Apache License, Version 2.0.

-------------------------------------------------------------------------------}

unit ExtensionProviders;

{$mode objfpc}{$H+}

interface

uses
  Classes, SysUtils;

function ExtensionProviderCall(const ProviderName, Operation,
  Payload: String): String;

implementation

uses
  AppSettings, fphttpclient, opensslsockets, fpjson, jsonparser;

const
  MaxProviderResponseSize = 16 * 1024 * 1024;

function IsLoopbackHttpUrl(const Url: String): Boolean;
var
  Authority, LowerUrl: String;
  SlashPos: Integer;
begin
  Result := False;
  LowerUrl := LowerCase(Url);
  if Pos('http://', LowerUrl) <> 1 then Exit;
  Authority := Copy(LowerUrl, Length('http://') + 1, MaxInt);
  SlashPos := Pos('/', Authority);
  if SlashPos > 0 then Authority := Copy(Authority, 1, SlashPos - 1);
  Result := (Authority = 'localhost') or (Pos('localhost:', Authority) = 1) or
    (Authority = '127.0.0.1') or (Pos('127.0.0.1:', Authority) = 1) or
    (Authority = '[::1]') or (Pos('[::1]:', Authority) = 1);
end;

function ExtensionProviderCall(const ProviderName, Operation,
  Payload: String): String;
var
  Provider: TProviderItem;
  Client: TFPHTTPClient;
  RequestBody, ResponseBody: TStringStream;
  RequestJson, SafePayload: String;
  Json, ResponseJson, ResultJson: TJSONData;
  ResponseObject: TJSONObject;
  JsonString: TJSONString;
  LowerUrl: String;
begin
  Provider := AppSet.ProviderList.FindItem(ProviderName);
  if Provider = nil then
    raise Exception.CreateFmt('Extension provider "%s" is not configured.',
      [ProviderName]);
  if Provider.Url = '' then
    raise Exception.CreateFmt('Extension provider "%s" has no URL.',
      [ProviderName]);
  LowerUrl := LowerCase(Provider.Url);
  if (Pos('http://', LowerUrl) <> 1) and (Pos('https://', LowerUrl) <> 1) then
    raise Exception.CreateFmt('Extension provider "%s" URL must use HTTP or HTTPS.',
      [ProviderName]);
  if (Pos('http://', LowerUrl) = 1) and not Provider.AllowInsecure and
     not IsLoopbackHttpUrl(LowerUrl) then
    raise Exception.CreateFmt('Extension provider "%s" must use HTTPS outside localhost.',
      [ProviderName]);

  if Trim(Payload) = '' then
    SafePayload := 'null'
  else
  begin
    Json := GetJSON(Payload);
    try
      SafePayload := Json.AsJSON;
    finally
      Json.Free;
    end;
  end;
  JsonString := TJSONString.Create(Operation);
  try
    RequestJson := '{"operation":' + JsonString.AsJSON +
      ',"payload":' + SafePayload + '}';
  finally
    JsonString.Free;
  end;
  RequestBody := TStringStream.Create(RequestJson);
  ResponseBody := TStringStream.Create('');
  Client := TFPHTTPClient.Create(nil);
  try
    Client.AllowRedirect := False;
    Client.IOTimeout := Provider.TimeoutMs;
    Client.AddHeader('Content-Type', 'application/json; charset=utf-8');
    Client.AddHeader('Accept', 'application/json');
    Client.AddHeader('X-DataExpress-Provider', Provider.Name);
    if Provider.Token <> '' then
      Client.AddHeader('Authorization', 'Bearer ' + Provider.Token);
    Client.RequestBody := RequestBody;
    Client.HTTPMethod('POST', Provider.Url, ResponseBody, [200, 201, 202]);
    if ResponseBody.Size > MaxProviderResponseSize then
      raise Exception.CreateFmt('Extension provider "%s" response is too large.',
        [ProviderName]);
    ResponseJson := GetJSON(ResponseBody.DataString);
    try
      if ResponseJson.JSONType <> jtObject then
        raise Exception.CreateFmt('Extension provider "%s" returned an invalid response.',
          [ProviderName]);
      ResponseObject := TJSONObject(ResponseJson);
      if not ResponseObject.Get('ok', False) then
        raise Exception.CreateFmt('Extension provider "%s" failed: %s',
          [ProviderName, ResponseObject.Get('error', 'Unknown provider error')]);
      ResultJson := ResponseObject.Find('result');
      if ResultJson = nil then
        Result := ''
      else if ResultJson.JSONType = jtString then
        Result := ResultJson.AsString
      else
        Result := ResultJson.AsJSON;
    finally
      ResponseJson.Free;
    end;
  finally
    Client.RequestBody := nil;
    Client.Free;
    ResponseBody.Free;
    RequestBody.Free;
  end;
end;

end.
