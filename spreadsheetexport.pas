{-------------------------------------------------------------------------------

  Web compatibility adapter for kok80-ExportToExcel4.0b1.

  The desktop extension automates Excel/LibreOffice through OLE and the local
  clipboard.  The web runtime instead writes an Excel 2003 XML workbook into
  the authenticated session cache and lets the browser download it.

-------------------------------------------------------------------------------}

unit SpreadsheetExport;

{$mode objfpc}{$H+}

interface

uses
  Classes, SysUtils, Db, DxTypes, DxCtrls;

const
  KOK80_EXPORT_FORM_ACTION_ID = '07B72A92-28B5-4707-96DA-D3D5AEC0FFE7';
  KOK80_EXPORT_MAIN_ACTION_ID = 'F477247A-3094-4D6B-8FD6-C8C91972A3B3';

type
  TKok80ExportOptions = record
    Enabled: Boolean;
    AddToMainToolbar: Boolean;
    AddToQueryToolbar: Boolean;
    AddToFormMenu: Boolean;
    AddToFormSelectedMenu: Boolean;
    AddToQueryMenu: Boolean;
    AddToQuerySelectedMenu: Boolean;
    Caption: String;
  end;

function GetKok80ExportOptions(SS: TSession): TKok80ExportOptions;
function ExportRecordSetToExcel(SS: TSession; RS: TSsRecordSet;
  QueryId: Integer; out PublicUrl, ErrorText: String): Boolean;
function ExportFormListToExcel(SS: TSession; Fm: TdxForm;
  out PublicUrl, ErrorText: String): Boolean;

implementation

uses
  DxReports, AppUtils, Variants;

function XmlEscape(const Value: String): String;
var
  i: Integer;
  S: String;
begin
  S := '';
  for i := 1 to Length(Value) do
    if (Ord(Value[i]) >= 32) or (Value[i] in [#9, #10, #13]) then
      S := S + Value[i];
  S := StringReplace(S, '&', '&amp;', [rfReplaceAll]);
  S := StringReplace(S, '<', '&lt;', [rfReplaceAll]);
  S := StringReplace(S, '>', '&gt;', [rfReplaceAll]);
  S := StringReplace(S, '"', '&quot;', [rfReplaceAll]);
  Result := S;
end;

function SafeWorksheetName(const Value: String): String;
const
  InvalidChars: set of Char = ['\', '/', '?', '*', '[', ']', ':'];
var
  i: Integer;
begin
  Result := '';
  for i := 1 to Length(Value) do
    if not (Value[i] in InvalidChars) and (Ord(Value[i]) >= 32) then
      Result := Result + Value[i];
  if Result = '' then Result := 'Data';
  if Length(Result) > 31 then SetLength(Result, 31);
end;

function SafeFilePart(const Value: String): String;
const
  InvalidChars: set of Char = ['\', '/', ':', '*', '?', '"', '<', '>', '|'];
var
  i: Integer;
begin
  Result := '';
  for i := 1 to Length(Value) do
    if not (Value[i] in InvalidChars) and (Ord(Value[i]) >= 32) then
      Result := Result + Value[i]
    else if (Length(Result) > 0) and (Result[Length(Result)] <> '_') then
      Result := Result + '_';
  Result := Trim(Result);
  if Result = '' then Result := 'DataExpress';
  if Length(Result) > 80 then SetLength(Result, 80);
end;

function ActionTag(const Actions, ActionId: String): String;
var
  LowerActions, Needle: String;
  IdPos, StartPos, EndPos: Integer;
begin
  Result := '';
  LowerActions := LowerCase(Actions);
  Needle := 'id="' + LowerCase(ActionId) + '"';
  IdPos := Pos(Needle, LowerActions);
  if IdPos = 0 then Exit;
  StartPos := IdPos;
  while (StartPos > 1) and (Actions[StartPos] <> '<') do Dec(StartPos);
  EndPos := IdPos;
  while (EndPos <= Length(Actions)) and (Actions[EndPos] <> '>') do Inc(EndPos);
  if (StartPos > 0) and (EndPos <= Length(Actions)) then
    Result := Copy(Actions, StartPos, EndPos - StartPos + 1);
end;

function TagAttribute(const Tag, Name, DefaultValue: String): String;
var
  LowerTag, Needle: String;
  P, E: Integer;
begin
  Result := DefaultValue;
  LowerTag := LowerCase(Tag);
  Needle := LowerCase(Name) + '="';
  P := Pos(Needle, LowerTag);
  if P = 0 then Exit;
  P := P + Length(Needle);
  E := P;
  while (E <= Length(Tag)) and (Tag[E] <> '"') do Inc(E);
  if E <= Length(Tag) then Result := Copy(Tag, P, E - P);
end;

function TagBoolean(const Tag, Name: String; DefaultValue: Boolean): Boolean;
var
  S: String;
begin
  S := LowerCase(Trim(TagAttribute(Tag, Name, '')));
  if S = '' then Exit(DefaultValue);
  Result := (S = '1') or (S = 'true') or (S = 'yes');
end;

function GetKok80ExportOptions(SS: TSession): TKok80ExportOptions;
var
  Tag: String;
begin
  FillChar(Result, SizeOf(Result), 0);
  Result.Caption := 'Выгрузить в Excel';
  if (SS = nil) or (SS.Main = nil) then Exit;
  Tag := ActionTag(SS.Main.Actions, KOK80_EXPORT_MAIN_ACTION_ID);
  Result.Enabled := Tag <> '';
  if not Result.Enabled then Exit;
  Result.AddToMainToolbar := TagBoolean(Tag, 'addtomaintoolbarbutton', False);
  Result.AddToQueryToolbar := TagBoolean(Tag, 'addtodxquerygridtoolbar', False);
  Result.AddToFormMenu := TagBoolean(Tag, 'addtodxformpopupmenu', False);
  Result.AddToFormSelectedMenu :=
    TagBoolean(Tag, 'addtodxformpopupmenuselected', False);
  Result.AddToQueryMenu := TagBoolean(Tag, 'addtodxquerygridpopupmenu', False);
  Result.AddToQuerySelectedMenu :=
    TagBoolean(Tag, 'addtodxquerygridpopupmenuselected', False);
  Result.Caption := TagAttribute(Tag, 'caption', Result.Caption);
  if Trim(Result.Caption) = '' then Result.Caption := 'Выгрузить в Excel';
end;

function TextCell(const Value: String; Header: Boolean = False): String;
begin
  Result := '<Cell';
  if Header then Result := Result + ' ss:StyleID="Header"';
  Result := Result + '><Data ss:Type="String">' + XmlEscape(Value) +
    '</Data></Cell>';
end;

function FieldCell(Field: TField; const DisplayValue: String;
  ForceText: Boolean): String;
var
  S: String;
begin
  if Field.IsNull then Exit('<Cell/>');
  if ForceText then Exit(TextCell(DisplayValue));
  case Field.DataType of
    ftSmallint, ftInteger, ftWord, ftFloat, ftCurrency, ftBCD, ftAutoInc,
    ftLargeint:
      begin
        S := FloatToStr(Field.AsFloat, DefaultFormatSettings);
        S := StringReplace(S, DefaultFormatSettings.DecimalSeparator, '.',
          [rfReplaceAll]);
        Result := '<Cell><Data ss:Type="Number">' + S + '</Data></Cell>';
      end;
    ftDate, ftTime, ftDateTime:
      Result := '<Cell><Data ss:Type="DateTime">' +
        FormatDateTime('yyyy"-"mm"-"dd"T"hh":"nn":"ss".000"', Field.AsDateTime) +
        '</Data></Cell>';
    ftBoolean:
      Result := '<Cell><Data ss:Type="Boolean">' +
        IntToStr(Ord(Field.AsBoolean)) + '</Data></Cell>';
    else
      Result := TextCell(DisplayValue);
  end;
end;

procedure AppendWorkbookHeader(SL: TStrings; const SheetName: String);
begin
  SL.Add('<?xml version="1.0" encoding="UTF-8"?>');
  SL.Add('<?mso-application progid="Excel.Sheet"?>');
  SL.Add('<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"');
  SL.Add(' xmlns:o="urn:schemas-microsoft-com:office:office"');
  SL.Add(' xmlns:x="urn:schemas-microsoft-com:office:excel"');
  SL.Add(' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">');
  SL.Add('<Styles><Style ss:ID="Default" ss:Name="Normal">' +
    '<Alignment ss:Vertical="Bottom"/><Font ss:FontName="Arial" ss:Size="10"/>' +
    '</Style><Style ss:ID="Header"><Font ss:Bold="1"/>' +
    '<Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/></Style></Styles>');
  SL.Add('<Worksheet ss:Name="' + XmlEscape(SafeWorksheetName(SheetName)) +
    '"><Table>');
end;

procedure AppendWorkbookFooter(SL: TStrings);
begin
  SL.Add('</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">' +
    '<FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal>' +
    '<TopRowBottomPane>1</TopRowBottomPane></WorksheetOptions></Worksheet>');
  SL.Add('</Workbook>');
end;

procedure AddColumn(SL: TStrings; Width: Integer);
var
  ExcelWidth: Double;
  S: String;
begin
  ExcelWidth := Width * 0.75;
  if ExcelWidth < 30 then ExcelWidth := 30;
  if ExcelWidth > 500 then ExcelWidth := 500;
  S := FloatToStr(ExcelWidth, DefaultFormatSettings);
  S := StringReplace(S, DefaultFormatSettings.DecimalSeparator, '.',
    [rfReplaceAll]);
  SL.Add('<Column ss:AutoFitWidth="0" ss:Width="' + S + '"/>');
end;

function FormFieldDisplayValue(SS: TSession; Fm: TdxForm; DS: TDataSet;
  F: TdxField): String;
var
  FF: TdxField;
begin
  if F is TdxDBImage then Exit('');
  if F is TdxFile then
    Exit(DS.FieldByName(FieldStr(F.Id) + 'd').AsString);
  if F is TdxLookupComboBox then
    Exit(DS.FieldByName(FieldStr(F.Id) + 'l').AsString);
  if F is TdxCheckBox then
  begin
    if DS.FieldByName(FieldStr(F.Id)).AsInteger = 1 then
      Exit(TdxCheckBox(F).CheckedText)
    else
      Exit(TdxCheckBox(F).UnCheckedText);
  end;
  if F is TdxObjectField then
    FF := GetObjectFieldField(SS, TdxObjectField(F))
  else
    FF := F;
  if (F is TdxCalcEdit) or (F is TdxTimeEdit) or
    (FF is TdxCalcEdit) or (FF is TdxTimeEdit) then
    Result := FormatField(DS.FieldByName(FieldStr(F.Id)), False)
  else
    Result := DS.FieldByName(FieldStr(F.Id)).AsString;
end;

function WriteWorkbook(SS: TSession; RS: TSsRecordSet; QueryId: Integer;
  out PublicUrl, ErrorText: String): Boolean;
var
  SL: TStringList;
  St: TFileStream;
  DS: TDataSet;
  Fm: TdxForm;
  Gr: TdxGrid;
  QRS: TSsRecordSet;
  ScrollRS: TSsRecordSet;
  RD: TReportData;
  Col: TdxColumn;
  RpCol: TRpGridColumn;
  F: TdxField;
  FileName, FullName, SheetName, RowXml, Value: String;
  i, StartRecNo, RowCount: Integer;
  ForceText: Boolean;
begin
  Result := False;
  PublicUrl := '';
  ErrorText := '';
  SL := TStringList.Create;
  try
    Fm := RS.Form;
    if Fm = nil then
    begin
      ErrorText := 'Export form was not found.';
      Exit;
    end;
    ScrollRS := RS;
    if QueryId > 0 then
    begin
      QRS := RS.Queries.FindRpById(QueryId);
      if QRS = nil then
      begin
        ErrorText := 'Запрос для экспорта не найден.';
        Exit;
      end;
      if not QRS.Open then
      begin
        ErrorText := 'Не удалось открыть запрос для экспорта.';
        Exit;
      end;
      ScrollRS := QRS;
      DS := QRS.DataSet;
      RD := QRS.RD;
      SheetName := RD.Name;
    end
    else
    begin
      DS := RS.DataSet;
      Gr := Fm.Grid;
      SheetName := Fm.GetRecordsCaption;
    end;
    if (DS = nil) or not DS.Active then
    begin
      ErrorText := 'Набор данных для экспорта не открыт.';
      Exit;
    end;

    AppendWorkbookHeader(SL, SheetName);
    if QueryId > 0 then
      for i := 0 to RD.Grid.ColumnCount - 1 do
      begin
        RpCol := RD.Grid.Columns[i];
        if RpCol.Visible and (RpCol.Width > 0) then AddColumn(SL, RpCol.Width);
      end
    else
      for i := 0 to Gr.Columns.Count - 1 do
      begin
        Col := Gr.Columns[i];
        if not Col.Visible or (Col.Width = 0) then Continue;
        F := Fm.FindField(Col.Id);
        if (F <> nil) and
          SS.UserMan.CheckControlVisible(SS.RoleId, Fm.Id, F.Name) then
          AddColumn(SL, Col.Width);
      end;

    RowXml := '<Row>';
    if QueryId > 0 then
      for i := 0 to RD.Grid.ColumnCount - 1 do
      begin
        RpCol := RD.Grid.Columns[i];
        if RpCol.Visible and (RpCol.Width > 0) then
          RowXml := RowXml + TextCell(RpCol.Caption, True);
      end
    else
      for i := 0 to Gr.Columns.Count - 1 do
      begin
        Col := Gr.Columns[i];
        if not Col.Visible or (Col.Width = 0) then Continue;
        F := Fm.FindField(Col.Id);
        if (F = nil) or
          not SS.UserMan.CheckControlVisible(SS.RoleId, Fm.Id, F.Name) then
          Continue;
        if Trim(Col.Caption) = '' then Value := F.FieldName
        else Value := Col.Caption;
        RowXml := RowXml + TextCell(Value, True);
      end;
    SL.Add(RowXml + '</Row>');

    StartRecNo := DS.RecNo;
    RowCount := 0;
    ScrollRS.DisableScrollEvents;
    try
      DS.First;
      while not DS.Eof do
      begin
        RowXml := '<Row>';
        if QueryId > 0 then
          for i := 0 to RD.Grid.ColumnCount - 1 do
          begin
            RpCol := RD.Grid.Columns[i];
            if not RpCol.Visible or (RpCol.Width = 0) then Continue;
            if RpCol.IsImage then
              RowXml := RowXml + '<Cell/>'
            else
            begin
              Value := FormatField(DS.FieldByName(RpCol.FieldNameDS), False);
              RowXml := RowXml + FieldCell(
                DS.FieldByName(RpCol.FieldNameDS), Value, False);
            end;
          end
        else
          for i := 0 to Gr.Columns.Count - 1 do
          begin
            Col := Gr.Columns[i];
            if not Col.Visible or (Col.Width = 0) then Continue;
            F := Fm.FindField(Col.Id);
            if (F = nil) or
              not SS.UserMan.CheckControlVisible(SS.RoleId, Fm.Id, F.Name) then
              Continue;
            Value := FormFieldDisplayValue(SS, Fm, DS, F);
            ForceText := (F is TdxFile) or (F is TdxLookupComboBox) or
              (F is TdxCheckBox) or (F is TdxMemo) or (F is TdxDBImage);
            RowXml := RowXml + FieldCell(
              DS.FieldByName(FieldStr(F.Id)), Value, ForceText);
          end;
        SL.Add(RowXml + '</Row>');
        Inc(RowCount);
        DS.Next;
      end;
      if (StartRecNo > 0) and (DS.RecordCount > 0) then
      begin
        DS.First;
        DS.MoveBy(StartRecNo - 1);
      end;
    finally
      ScrollRS.EnableScrollEvents;
    end;
    AppendWorkbookFooter(SL);

    FileName := SafeFilePart(SheetName) + '-' + GenerateId + '.xls';
    FullName := GetCachePath(SS) + FileName;
    St := TFileStream.Create(FullName, fmCreate);
    try
      Value := #$EF#$BB#$BF + SL.Text;
      if Length(Value) > 0 then St.WriteBuffer(Value[1], Length(Value));
    finally
      St.Free;
    end;
    PublicUrl := GetCachePath(SS, True) + FileName;
    LogString('AUDIT spreadsheet_export connection=' +
      SafeFilePart(SS.GetCurrentDatabase) + ' user=' +
      SafeFilePart(SS.GetCurrentUser) + ' ip=' + SafeFilePart(SS.IP) +
      ' rows=' + IntToStr(RowCount) +
      ' query_id=' + IntToStr(QueryId));
    Result := True;
  except
    on E: Exception do ErrorText := E.Message;
  end;
  SL.Free;
end;

function ExportRecordSetToExcel(SS: TSession; RS: TSsRecordSet;
  QueryId: Integer; out PublicUrl, ErrorText: String): Boolean;
begin
  if (SS = nil) or (RS = nil) then
  begin
    PublicUrl := '';
    ErrorText := 'Форма для экспорта не открыта.';
    Exit(False);
  end;
  Result := WriteWorkbook(SS, RS, QueryId, PublicUrl, ErrorText);
end;

function ExportFormListToExcel(SS: TSession; Fm: TdxForm;
  out PublicUrl, ErrorText: String): Boolean;
var
  RS: TSsRecordSet;
begin
  PublicUrl := '';
  ErrorText := '';
  if (SS = nil) or (Fm = nil) then
  begin
    ErrorText := 'Форма для экспорта не найдена.';
    Exit(False);
  end;
  RS := TSsRecordSet.Create(SS, nil);
  try
    RS.AssignForm(Fm);
    RS.OpenRecords;
    Result := WriteWorkbook(SS, RS, 0, PublicUrl, ErrorText);
  finally
    RS.Free;
  end;
end;

end.
