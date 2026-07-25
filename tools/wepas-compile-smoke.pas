program WepasCompileSmoke;

{$mode objfpc}{$H+}

uses
  {$ifdef unix}Interfaces,{$endif}
  Classes, SysUtils, fpjson, jsonparser, uPSCompiler, uPSUtils, CompilerDecls,
  AppSettings, ScriptManager, DxTypes;

function RegisterSystemDeclarations(Sender: TPSPascalCompiler;
  const Name: tbtString): Boolean;
begin
  Result := UpperCase(Name) = 'SYSTEM';
  if Result then
  begin
    SIRegister_All(Sender);
    Sender.AddUsedVariableN('Session', 'TSession');
    Sender.AddUsedVariableN('Self', 'TdxForm');
  end;
end;

procedure Require(Condition: Boolean; const MessageText: String);
begin
  if not Condition then raise Exception.Create(MessageText);
end;

{$IFDEF WINDOWS}
procedure CheckWindowsWorkerCompatibility;
var
  AddedActions, AddedFunctions, ClaimedActions, ClaimedFunctions,
    CompileErrors: TStringList;
  AutoSource, DesktopSource: String;
  Manager: TScriptManager;
  MetaData: TMetaData;
  WebScript: TScriptData;
begin
  Require(AutomaticWebBlockReason(
    'begin CreateOleObject(''Scripting.Dictionary''); end;') =
    'CreateOleObject',
    'COM must remain blocked outside the isolated worker');

  AppSet.WindowsWorkerMode := True;
  AddedActions := TStringList.Create;
  AddedFunctions := TStringList.Create;
  ClaimedActions := TStringList.Create;
  ClaimedFunctions := TStringList.Create;
  try
    Require(AutomaticWebBlockReason(
      'begin CreateOleObject(''Scripting.Dictionary''); end;') = '',
      'The isolated Windows worker did not enable COM');
    Require(AutomaticWebBlockReason(
      'begin ShellExecute('''', ''open'', ''tool.exe'', '''', '''', 0); end;') = '',
      'The isolated Windows worker did not enable Windows APIs');

    DesktopSource :=
      '{@module' + LineEnding +
      'Author=DataExpress tests' + LineEnding +
      'Version=1.0' + LineEnding +
      'Description=Windows worker COM smoke' + LineEnding +
      '@}' + LineEnding + LineEnding +
      '{@function' + LineEnding +
      'Name=WINDOWS_DICTIONARY_COUNT' + LineEnding +
      'Args=' + LineEnding +
      'Result=i' + LineEnding +
      'Group=Windows' + LineEnding +
      'Description=Compiles an OLE automation call' + LineEnding +
      '@}' + LineEnding + LineEnding +
      'function WindowsDictionaryCount: Integer;' + LineEnding +
      'var Dictionary: OleVariant;' + LineEnding +
      'begin' + LineEnding +
      '  Dictionary := CreateOleObject(''Scripting.Dictionary'');' + LineEnding +
      '  Result := Dictionary.Count;' + LineEnding +
      'end;';
    AutoSource := BuildAutomaticWebExtensionSource(DesktopSource,
      ClaimedActions, ClaimedFunctions, AddedActions, AddedFunctions);
    Require(AutoSource <> '',
      'Windows-only desktop extension was not promoted inside the worker');

    MetaData := TMetaData.Create;
    try
      Manager := MetaData.ScriptMan;
      WebScript := Manager.AddScript(0, '__auto_web_windows_com', AutoSource);
      WebScript.Kind := skWebExpr;
      Manager.ParseExprModule(WebScript);
      Manager.CompileModule(WebScript);
      if Manager.HasErrorsInModule(WebScript) then
      begin
        CompileErrors := TStringList.Create;
        try
          Manager.ModuleMessagesToList(WebScript, CompileErrors, True);
          Require(False, 'Windows worker COM source compile failed: ' +
            CompileErrors.Text);
        finally
          CompileErrors.Free;
        end;
      end;
    finally
      MetaData.Free;
    end;
  finally
    AppSet.WindowsWorkerMode := False;
    ClaimedFunctions.Free;
    ClaimedActions.Free;
    AddedFunctions.Free;
    AddedActions.Free;
  end;
  WriteLn('windows-worker-com-compile-ok');
end;
{$ENDIF}

procedure CompatibilityStatuses(const Json: String; out FirstStatus,
  SecondStatus: String; out Complete: Boolean);
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
    FirstStatus := Item.Get('status', '');
    SecondStatus := TJSONObject(Functions.Items[1]).Get('status', '');
    Complete := Summary.Get('complete', False);
  finally
    Data.Free;
  end;
end;

var
  Compiler: TPSPascalCompiler;
  AddedActions, AddedFunctions, ClaimedActions, ClaimedFunctions,
    CompileErrors, DesktopSource, WebSource: TStringList;
  AutoSource, Output, FirstStatus, SecondStatus, ExpectedMode: String;
  i: Integer;
  Manager: TScriptManager;
  MetaData: TMetaData;
  DesktopScript, WebScript: TScriptData;
  Provider: TProviderItem;
  Complete: Boolean;
begin
  if ParamCount <> 3 then
    raise Exception.Create(
      'Usage: wepas-compile-smoke <module.epas> <module.wepas> <provider|web-script|mixed>');
  ExpectedMode := LowerCase(ParamStr(3));
  Require((ExpectedMode = 'provider') or (ExpectedMode = 'web-script') or
    (ExpectedMode = 'mixed'), 'Unknown expected compatibility mode');

  DesktopSource := TStringList.Create;
  WebSource := TStringList.Create;
  Compiler := TPSPascalCompiler.Create;
  try
    DesktopSource.LoadFromFile(ParamStr(1));
    WebSource.LoadFromFile(ParamStr(2));
    WebSource.Add('{ ExtensionProviderCall(''Ghost'', ''ignored'', ''payload''); }');
    WebSource.Add('procedure LegacyGotoFormCompatibilitySmoke;');
    WebSource.Add('begin');
    WebSource.Add('  Self.GotoForm(''Compatibility'', 1);');
    WebSource.Add('  Self.GotoForm(''Compatibility'', 1, False);');
    WebSource.Add('  Self.GotoForm(''Compatibility'', 1, gtoDefault);');
    WebSource.Add('end;');
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
    {$IFDEF WINDOWS}
    CheckWindowsWorkerCompatibility;
    {$ENDIF}
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

      CompatibilityStatuses(Manager.ExtensionCompatibilityAsJson,
        FirstStatus, SecondStatus, Complete);
      if ExpectedMode = 'web-script' then
      begin
        Require((FirstStatus = 'web-script') and (SecondStatus = 'web-script'),
          'Inline functions were not detected independently: ' +
          FirstStatus + ', ' + SecondStatus);
        Require(Complete, 'Inline web functions must complete compatibility');
      end
      else
      begin
        if ExpectedMode = 'mixed' then
          Require((FirstStatus = 'web-script') and
            (SecondStatus = 'provider-unconfigured'),
            'Mixed mapping status is incorrect: ' +
            FirstStatus + ', ' + SecondStatus)
        else
          Require((FirstStatus = 'provider-unconfigured') and
            (SecondStatus = 'provider-unconfigured'),
            'Missing provider configuration was not detected: ' +
            FirstStatus + ', ' + SecondStatus);
        Require(not Complete,
          'Unconfigured provider must keep compatibility incomplete');

        Provider := AppSet.ProviderList.AddItem;
        Provider.Name := ChangeFileExt(ExtractFileName(ParamStr(1)), '');
        CompatibilityStatuses(Manager.ExtensionCompatibilityAsJson,
          FirstStatus, SecondStatus, Complete);
        Require(SecondStatus = 'provider-unconfigured',
          'Provider without Url must remain unconfigured: ' + SecondStatus);
        Require(not Complete,
          'Provider without Url must keep compatibility incomplete');

        Provider.Url := 'http://127.0.0.1:19081/';
        CompatibilityStatuses(Manager.ExtensionCompatibilityAsJson,
          FirstStatus, SecondStatus, Complete);
        if ExpectedMode = 'mixed' then
          Require((FirstStatus = 'web-script') and (SecondStatus = 'provider'),
            'Configured mixed provider status is incorrect: ' +
            FirstStatus + ', ' + SecondStatus)
        else
          Require((FirstStatus = 'provider') and (SecondStatus = 'provider'),
            'Configured provider was not detected: ' +
            FirstStatus + ', ' + SecondStatus);
        Require(Complete, 'Configured provider must complete compatibility');
      end;
    finally
      Manager.Free;
    end;

    if ExpectedMode = 'web-script' then
    begin
      AddedActions := TStringList.Create;
      AddedFunctions := TStringList.Create;
      ClaimedActions := TStringList.Create;
      ClaimedFunctions := TStringList.Create;
      try
        AutoSource := BuildAutomaticWebExtensionSource(DesktopSource.Text,
          ClaimedActions, ClaimedFunctions, AddedActions, AddedFunctions);
        Require(AutoSource <> '', 'Portable desktop extension was not promoted');
        Require(AddedFunctions.IndexOf('NORMALIZE_PHONE') >= 0,
          'Name metadata was confused with OrigName');
        Require(Pos('OrigName=', AutoSource) = 0,
          'Desktop function metadata leaked into automatic web metadata');
        Require(AutomaticWebBlockReason(
          'begin SaveToFile(''outside.txt''); end;') = 'SaveToFile',
          'Direct filesystem access was not isolated');
        Require(AutomaticWebBlockReason(
          '// SaveToFile must not count inside a comment' + LineEnding +
          'begin Result := ''ShellExecute is only text''; end;') = '',
          'Comments or strings incorrectly blocked a portable extension');

        MetaData := TMetaData.Create;
        try
          Manager := MetaData.ScriptMan;
          DesktopScript := Manager.AddScript(0, 'portable.epas',
            DesktopSource.Text);
          DesktopScript.Kind := skExpr;
          WebScript := Manager.AddScript(0, '__auto_web_portable',
            AutoSource);
          WebScript.Kind := skWebExpr;
          Manager.CompileModule(WebScript);
          if Manager.HasErrorsInModule(WebScript) then
          begin
            CompileErrors := TStringList.Create;
            try
              Manager.ModuleMessagesToList(WebScript, CompileErrors, True);
              Require(False, 'Automatic source compile failed: ' +
                CompileErrors.Text);
            finally
              CompileErrors.Free;
            end;
          end;
          Manager.CompileExpr;
          Require(not Manager.HasErrors,
            'Automatic portable extension failed compilation');
          CompatibilityStatuses(Manager.ExtensionCompatibilityAsJson,
            FirstStatus, SecondStatus, Complete);
          Require((FirstStatus = 'auto-web-script') and
            (SecondStatus = 'auto-web-script'),
            'Automatic fallback status is incorrect: ' +
            FirstStatus + ', ' + SecondStatus);
          Require(Complete, 'Automatic portable extension must be complete');
        finally
          MetaData.Free;
        end;
      finally
        ClaimedFunctions.Free;
        ClaimedActions.Free;
        AddedFunctions.Free;
        AddedActions.Free;
      end;
      WriteLn('automatic-epas-fallback-ok');
    end;

    WriteLn('wepas-compile-ok ' + ExtractFileName(ParamStr(2)));
    WriteLn('mapping-granularity-ok ' + ExpectedMode);
    if ExpectedMode <> 'web-script' then
      WriteLn('provider-config-diagnostics-ok');
  finally
    AppSet.Free;
    AppSet := nil;
    Compiler.Free;
    WebSource.Free;
    DesktopSource.Free;
  end;
end.
