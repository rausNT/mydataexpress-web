{-------------------------------------------------------------------------------

    Portable extension provider bridge for DataExpress Web Server.
    Licensed under the Apache License, Version 2.0.

-------------------------------------------------------------------------------}

unit ExtensionProviders;

{$mode objfpc}{$H+}

interface

uses
  Classes, SysUtils, Variants;

function ExtensionProviderCall(const ProviderName, Operation,
  Payload: String): String;
function ExtensionProviderCallBoolean(const ProviderName, Operation,
  Payload: String): Boolean;
function ExtensionProviderCallInt64(const ProviderName, Operation,
  Payload: String): Int64;
function ExtensionProviderCallFloat(const ProviderName, Operation,
  Payload: String): Double;
function ExtensionProviderCallDateTime(const ProviderName, Operation,
  Payload: String): TDateTime;
function ExtensionProviderCallVariant(const ProviderName, Operation,
  Payload: String): Variant;
function ExtensionProviderEncodeValue(const Value: Variant): String;

implementation

uses
  AppSettings, fphttpclient, opensslsockets, fpjson, jsonparser, DateUtils;

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
    // An empty list accepts every HTTP status so the JSON error envelope can be
    // read instead of being replaced by a generic EHTTPClient exception.
    Client.HTTPMethod('POST', Provider.Url, ResponseBody, []);
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
        raise Exception.CreateFmt(
          'Extension provider "%s" operation "%s" failed (HTTP %d): %s',
          [ProviderName, Operation, Client.ResponseStatusCode,
          ResponseObject.Get('error', 'Unknown provider error')]);
      if (Client.ResponseStatusCode < 200) or (Client.ResponseStatusCode > 299) then
        raise Exception.CreateFmt(
          'Extension provider "%s" operation "%s" returned HTTP %d.',
          [ProviderName, Operation, Client.ResponseStatusCode]);
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

function ExtensionProviderCallBoolean(const ProviderName, Operation,
  Payload: String): Boolean;
var
  Value: String;
begin
  Value := Trim(ExtensionProviderCall(ProviderName, Operation, Payload));
  if SameText(Value, 'true') or (Value = '1') then
    Exit(True);
  if SameText(Value, 'false') or (Value = '0') then
    Exit(False);
  raise Exception.CreateFmt(
    'Extension provider "%s" operation "%s" did not return a boolean.',
    [ProviderName, Operation]);
end;

function ExtensionProviderCallInt64(const ProviderName, Operation,
  Payload: String): Int64;
var
  Value: String;
begin
  Value := Trim(ExtensionProviderCall(ProviderName, Operation, Payload));
  if not TryStrToInt64(Value, Result) then
    raise Exception.CreateFmt(
      'Extension provider "%s" operation "%s" did not return an integer.',
      [ProviderName, Operation]);
end;

function ExtensionProviderCallFloat(const ProviderName, Operation,
  Payload: String): Double;
var
  Value: String;
  FormatSettings: TFormatSettings;
begin
  Value := Trim(ExtensionProviderCall(ProviderName, Operation, Payload));
  FormatSettings := DefaultFormatSettings;
  FormatSettings.DecimalSeparator := '.';
  FormatSettings.ThousandSeparator := #0;
  if not TryStrToFloat(Value, Result, FormatSettings) then
    raise Exception.CreateFmt(
      'Extension provider "%s" operation "%s" did not return a number.',
      [ProviderName, Operation]);
end;

function ExtensionProviderCallDateTime(const ProviderName, Operation,
  Payload: String): TDateTime;
var
  Value: String;
  FormatSettings: TFormatSettings;
begin
  Value := Trim(ExtensionProviderCall(ProviderName, Operation, Payload));
  FormatSettings := DefaultFormatSettings;
  FormatSettings.DecimalSeparator := '.';
  FormatSettings.ThousandSeparator := #0;
  if TryStrToFloat(Value, Result, FormatSettings) then Exit;
  try
    Result := ISO8601ToDate(Value, False);
  except
    on E: Exception do
      raise Exception.CreateFmt(
        'Extension provider "%s" operation "%s" did not return an ISO 8601 date or DataExpress date number.',
        [ProviderName, Operation]);
  end;
end;

function ExtensionProviderCallVariant(const ProviderName, Operation,
  Payload: String): Variant;
var
  Value: String;
  Json: TJSONData;
begin
  Value := ExtensionProviderCall(ProviderName, Operation, Payload);
  if Value = '' then Exit(Null);
  try
    Json := GetJSON(Value);
  except
    Exit(Value);
  end;
  try
    case Json.JSONType of
      jtNull: Result := Null;
      jtArray, jtObject: Result := Json.AsJSON;
      else Result := Json.Value;
    end;
  finally
    Json.Free;
  end;
end;

function ExtensionProviderEncodeValue(const Value: Variant): String;
var
  Json: TJSONData;
begin
  case VarType(Value) of
    varEmpty, varNull: Json := CreateJSON;
    varByte, varSmallint, varInteger, varWord: Json := CreateJSON(Integer(Value));
    varBoolean: Json := CreateJSON(Boolean(Value));
    varSingle, varDouble, varCurrency: Json := CreateJSON(Double(Value));
    varDate: Json := CreateJSON(DateToISO8601(TDateTime(Value), False));
    varInt64: Json := CreateJSON(Int64(Value));
    varLongWord, varQWord: Json := CreateJSON(QWord(Value));
    else Json := CreateJSON(VarToStr(Value));
  end;
  try
    Result := Json.AsJSON;
  finally
    Json.Free;
  end;
end;

end.
