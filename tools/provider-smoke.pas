program ProviderSmoke;

{$mode objfpc}{$H+}

uses
  SysUtils, Variants, DateUtils, fpjson, jsonparser, AppSettings,
  ExtensionProviders;

procedure Require(Condition: Boolean; const MessageText: String);
begin
  if not Condition then raise Exception.Create(MessageText);
end;

var
  Provider: TProviderItem;
  Payload, VariantResult: String;
  VariantJson: TJSONData;
  DateResult: TDateTime;
  YearValue, MonthValue, DayValue: Word;
begin
  if ParamCount < 2 then
    raise Exception.Create('Usage: provider-smoke <url> <token>');

  AppSet := TAppSettings.Create;
  try
    Provider := AppSet.ProviderList.AddItem;
    Provider.Name := 'Smoke';
    Provider.Url := ParamStr(1);
    Provider.Token := ParamStr(2);
    Provider.TimeoutMs := 10000;
    Provider.AllowInsecure := False;

    Payload := '{"text":' + ExtensionProviderEncodeValue('hello') +
      ',"enabled":' + ExtensionProviderEncodeValue(True) +
      ',"count":' + ExtensionProviderEncodeValue(7) +
      ',"amount":' + ExtensionProviderEncodeValue(2.5) + '}';
    WriteLn('provider-smoke-payload ' + Payload);
    Require(ExtensionProviderCall('Smoke', 'echo_types', Payload) = 'types-ok',
      'String result or typed payload failed');
    Require(ExtensionProviderCallBoolean('Smoke', 'boolean_value', '{}'),
      'Boolean result failed');
    Require(ExtensionProviderCallInt64('Smoke', 'integer_value', '{}') = 42,
      'Integer result failed');
    Require(Abs(ExtensionProviderCallFloat('Smoke', 'float_value', '{}') - 12.5) < 0.0001,
      'Float result failed');

    DateResult := ExtensionProviderCallDateTime('Smoke', 'datetime_value', '{}');
    DecodeDate(DateResult, YearValue, MonthValue, DayValue);
    Require((YearValue = 2026) and (MonthValue = 7) and (DayValue = 22),
      'DateTime result failed');

    VariantResult := VarToStr(ExtensionProviderCallVariant(
      'Smoke', 'variant_value', '{}'));
    VariantJson := GetJSON(VariantResult);
    try
      Require((VariantJson.JSONType = jtObject) and
        TJSONObject(VariantJson).Get('accepted', False), 'Variant result failed');
    finally
      VariantJson.Free;
    end;

    WriteLn('provider-smoke-ok');
  finally
    AppSet.Free;
    AppSet := nil;
  end;
end.
