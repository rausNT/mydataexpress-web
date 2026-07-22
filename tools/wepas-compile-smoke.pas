program WepasCompileSmoke;

{$mode objfpc}{$H+}

uses
  Classes, SysUtils, fpjson, jsonparser, uPSCompiler, uPSUtils, CompilerDecls,
  AppSettings, ScriptManager;

function RegisterSystemDeclarations(Sender: TPSPascalCompiler;
  const Name: tbtString): Boolean;
begin
  Result := UpperCase(Name) = 'SYSTEM';
  if Result then
    SIRegister_All(Sender);
end;

procedure Require(Condition: Boolean; const MessageText: String);
begin
  if not Condition then raise Exception.Create(MessageText);
end;

function CompatibilityStatus(const Json: String; out Complete: Boolean): String;
var
  Data: TJSONData;
  Root, Summary, Item: TJSONObject;
  Functions: TJSONArray;
begin
  Data := GetJSON(Json);
  try
    Root := TJSONObject(Data);
    Summary := TJSONObject(Root.Find('summary'));
    Functions := TJSONArray(Root.Find('functions'));
    Require(Functions.Count = 2, 'Expected two extension functions');
    Item := TJSONObject(Functions.Items[0]);
    Result := Item.Get('status', '');
    Require(TJSONObject(Functions.Items[1]).Get('status', '') = Result,
      'Extension functions have inconsistent compatibility status');
    Complete := Summary.Get('complete', False);
  finally
    Data.Free;
  end;
end;

var
  Compiler: TPSPascalCompiler;
  DesktopSource, WebSource: TStringList;
  Output, Status: String;
  i: Integer;
  Manager: TScriptManager;
  DesktopScript, WebScript: TScriptData;
  Provider: TProviderItem;
  Complete: Boolean;
begin
  if ParamCount <> 2 then
    raise Exception.Create('Usage: wepas-compile-smoke <module.epas> <module.wepas>');

  DesktopSource := TStringList.Create;
  WebSource := TStringList.Create;
  Compiler := TPSPascalCompiler.Create;
  try
    DesktopSource.LoadFromFile(ParamStr(1));
    WebSource.LoadFromFile(ParamStr(2));
    WebSource.Add('{ ExtensionProviderCall(''Ghost'', ''ignored'', ''payload''); }');
    Compiler.BooleanShortCircuit := True;
    Compiler.AllowNoBegin := True;
    Compiler.AllowNoEnd := True;
    Compiler.AllowDuplicateRegister := False;
    Compiler.OnUses := @RegisterSystemDeclarations;

    if not Compiler.Compile(WebSource.Text) then
    begin
      for i := 0 to Compiler.MsgCount - 1 do
        WriteLn(Compiler.Msg[i].MessageToString);
      Halt(1);
    end;
    if not Compiler.GetOutput(Output) then
      raise Exception.Create('Pascal Script compiler produced no output');
    if Output = '' then
      raise Exception.Create('Pascal Script compiler produced an empty program');

    AppSet := TAppSettings.Create;
    Manager := TScriptManager.Create(nil);
    try
      DesktopScript := Manager.AddScript(0, ExtractFileName(ParamStr(1)),
        DesktopSource.Text);
      DesktopScript.Kind := skExpr;
      Manager.ParseExprModule(DesktopScript);
      WebScript := Manager.AddScript(0, ExtractFileName(ParamStr(2)),
        WebSource.Text);
      WebScript.Kind := skWebExpr;
      Manager.ParseExprModule(WebScript);
      Require(not Manager.HasErrors, 'Extension metadata parser rejected the generated pair');

      Status := CompatibilityStatus(Manager.ExtensionCompatibilityAsJson, Complete);
      Require(Status = 'provider-unconfigured',
        'Missing provider configuration was not detected: ' + Status);
      Require(not Complete, 'Unconfigured provider must keep compatibility incomplete');

      Provider := AppSet.ProviderList.AddItem;
      Provider.Name := 'portable';
      Status := CompatibilityStatus(Manager.ExtensionCompatibilityAsJson, Complete);
      Require(Status = 'provider-unconfigured',
        'Provider without Url must remain unconfigured: ' + Status);
      Require(not Complete, 'Provider without Url must keep compatibility incomplete');

      Provider.Url := 'http://127.0.0.1:19081/';
      Status := CompatibilityStatus(Manager.ExtensionCompatibilityAsJson, Complete);
      Require(Status = 'provider', 'Configured provider was not detected: ' + Status);
      Require(Complete, 'Configured provider must complete compatibility');
    finally
      Manager.Free;
      AppSet.Free;
      AppSet := nil;
    end;

    WriteLn('wepas-compile-ok ' + ExtractFileName(ParamStr(2)));
    WriteLn('provider-config-diagnostics-ok');
  finally
    Compiler.Free;
    WebSource.Free;
    DesktopSource.Free;
  end;
end.
