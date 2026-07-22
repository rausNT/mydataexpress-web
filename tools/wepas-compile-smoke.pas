program WepasCompileSmoke;

{$mode objfpc}{$H+}

uses
  Classes, SysUtils, uPSCompiler, ScriptManager;

var
  Compiler: TScriptCompiler;
  Script: TScriptData;
  Source: TStringList;
  Output: String;
  i: Integer;
begin
  if ParamCount <> 1 then
    raise Exception.Create('Usage: wepas-compile-smoke <module.wepas>');

  Source := TStringList.Create;
  Script := TScriptData.Create;
  Compiler := TScriptCompiler.Create(nil);
  try
    Source.LoadFromFile(ParamStr(1));
    Script.Name := ExtractFileName(ParamStr(1));
    Script.Kind := skWebMain;
    Script.Source := Source.Text;
    Compiler.SD := Script;

    if not Compiler.Compile(Script.Source) then
    begin
      for i := 0 to Compiler.MsgCount - 1 do
        WriteLn(Compiler.Msg[i].MessageToString);
      Halt(1);
    end;
    if not Compiler.GetOutput(Output) then
      raise Exception.Create('Pascal Script compiler produced no output');
    if Output = '' then
      raise Exception.Create('Pascal Script compiler produced an empty program');

    WriteLn('wepas-compile-ok ' + Script.Name);
  finally
    Compiler.Free;
    Script.Free;
    Source.Free;
  end;
end.
