{-------------------------------------------------------------------------------

    Copyright 2016-2024 Pavel Duborkin ( mydataexpress@mail.ru )

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

-------------------------------------------------------------------------------}

unit SAXBaseReader;

{$mode objfpc}{$H+}

interface

uses
  Classes, SysUtils, SAX, SAX_XML, LazUtf8;

type

  { TSAXBaseReader }

	TSAXBaseReader = class(TSaxXmlReader)
  public
    procedure ParseStream(AStream: TStream); reintroduce;
    function GetBool(Atts: TSAXAttributes; const aName: String): Boolean;
    function GetInt(Atts: TSAXAttributes; const aName: String): Integer;
    function GetStr(Atts: TSAXAttributes; const aName: String): String;
    function AttrExists(Atts: TSAXAttributes; const aName: String): Boolean;
  end;

implementation

{ TSAXBaseReader }

function NormalizeLegacyXml(const Xml: String): String;
var
  i, LastCopy: Integer;

  function HasNamedEntity(P: Integer): Boolean;
  begin
    Result := (Copy(Xml, P, 5) = '&amp;') or
      (Copy(Xml, P, 6) = '&quot;') or
      (Copy(Xml, P, 4) = '&lt;') or
      (Copy(Xml, P, 4) = '&gt;') or
      (Copy(Xml, P, 6) = '&apos;');
  end;

  function HasNumericEntity(P: Integer): Boolean;
  var
    j, DigitStart: Integer;
  begin
    Result := False;
    if Copy(Xml, P, 2) <> '&#' then Exit;
    j := P + 2;
    if (j <= Length(Xml)) and (Xml[j] in ['x', 'X']) then Inc(j);
    DigitStart := j;
    while (j <= Length(Xml)) and
      (Xml[j] in ['0'..'9', 'a'..'f', 'A'..'F']) do Inc(j);
    Result := (j > DigitStart) and (j <= Length(Xml)) and (Xml[j] = ';');
  end;

  function ProtectAttributeExclamations(const S: String): String;
  var
    P, CopyFrom: Integer;
    Quote: Char;
  begin
    Result := '';
    CopyFrom := 1;
    Quote := #0;
    for P := 1 to Length(S) do
    begin
      if Quote = #0 then
      begin
        if S[P] in ['"', ''''] then Quote := S[P];
      end
      else if S[P] = Quote then
        Quote := #0
      else if S[P] = '!' then
      begin
        Result := Result + Copy(S, CopyFrom, P - CopyFrom) +
          '__DATAEXPRESS_EXCLAMATION__';
        CopyFrom := P + 1;
      end;
    end;
    if CopyFrom = 1 then
      Result := S
    else
      Result := Result + Copy(S, CopyFrom, MaxInt);
  end;

begin
  Result := '';
  LastCopy := 1;
  i := 1;
  while i <= Length(Xml) do
  begin
    if (Xml[i] = '&') and not HasNamedEntity(i) and not HasNumericEntity(i) then
    begin
      Result := Result + Copy(Xml, LastCopy, i - LastCopy) + '&amp;';
      LastCopy := i + 1;
    end;
    Inc(i);
  end;
  if LastCopy = 1 then
    Result := Xml
  else
    Result := Result + Copy(Xml, LastCopy, MaxInt);

  // FPC's Linux SAX reader truncates legacy DataExpress attributes at these
  // source markers. Keep them reversible until XmlToStr decodes the value.
  Result := StringReplace(Result, '[?!',
    '[__DATAEXPRESS_OPTIONAL_PARENT__', [rfReplaceAll]);
  Result := StringReplace(Result, '[!',
    '[__DATAEXPRESS_PARENT__', [rfReplaceAll]);
  Result := StringReplace(Result, '[?',
    '[__DATAEXPRESS_OPTIONAL__', [rfReplaceAll]);
  Result := ProtectAttributeExclamations(Result);
end;

procedure TSAXBaseReader.ParseStream(AStream: TStream);
var
  Xml: String;
  XmlStream: TStringStream;
begin
  SetLength(Xml, AStream.Size - AStream.Position);
  if Length(Xml) > 0 then AStream.ReadBuffer(Xml[1], Length(Xml));
  XmlStream := TStringStream.Create(NormalizeLegacyXml(Xml));
  try
    inherited ParseStream(XmlStream);
  finally
    XmlStream.Free;
  end;
end;

function TSAXBaseReader.GetBool(Atts: TSAXAttributes; const aName: String
  ): Boolean;
var
  S: String;
begin
  Result := False;
  S := GetStr(Atts, aName);
  if S = '1' then Result := True;
end;

function TSAXBaseReader.GetInt(Atts: TSAXAttributes; const aName: String
  ): Integer;
var
  S: String;
begin
  Result := 0;
  S := GetStr(Atts, aName);
  if S <> '' then TryStrToInt(S, Result);
end;

function TSAXBaseReader.GetStr(Atts: TSAXAttributes; const aName: String
  ): String;
var
  i: Integer;
  S: String;
begin
  Result := '';
  if Atts = nil then Exit;
  for i := 0 to Atts.Length - 1 do
  begin
    S := Atts.GetLocalName(i);
		if CompareText(S, aName) = 0 then
      Exit( UTF8Encode(Atts.GetValue(i)) );
  end;
end;

function TSAXBaseReader.AttrExists(Atts: TSAXAttributes; const aName: String
  ): Boolean;
var
  i: Integer;
  S: String;
begin
  Result := False;
  if Atts = nil then Exit;
  for i := 0 to Atts.Length - 1 do
  begin
    S := Atts.GetLocalName(i);
		if CompareText(S, aName) = 0 then
    	Exit( True );
  end;
end;

end.

