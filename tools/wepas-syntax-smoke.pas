program WepasSyntaxSmoke;

{$mode objfpc}{$H+}

uses
  Classes, SysUtils, uPSCompiler, uPSUtils, CompilerDecls;

function RegisterSystemDeclarations(Sender: TPSPascalCompiler;
  const Name: tbtString): Boolean;
begin
  Result := UpperCase(Name) = 'SYSTEM';
  if Result then
    SIRegister_All(Sender);
end;

var
  Compiler: TPSPascalCompiler;
  Source: TStringList;
  Output: String;
  i: Integer;
begin
  if ParamCount <> 1 then
    raise Exception.Create('Usage: wepas-syntax-smoke <module.wepas>');

  Source := TStringList.Create;
  Compiler := TPSPascalCompiler.Create;
  try
    Source.LoadFromFile(ParamStr(1));
    Compiler.BooleanShortCircuit := True;
    Compiler.AllowNoBegin := True;
    Compiler.AllowNoEnd := True;
    Compiler.AllowDuplicateRegister := False;
    Compiler.OnUses := @RegisterSystemDeclarations;
    if not Compiler.Compile(Source.Text) then
    begin
      for i := 0 to Compiler.MsgCount - 1 do
        WriteLn(Compiler.Msg[i].MessageToString);
      Halt(1);
    end;
    if not Compiler.GetOutput(Output) then
      raise Exception.Create('Pascal Script compiler produced no output');
    if Output = '' then
      raise Exception.Create('Pascal Script compiler produced an empty program');
    WriteLn('wepas-syntax-ok ' + ExtractFileName(ParamStr(1)));
  finally
    Compiler.Free;
    Source.Free;
  end;
end.
