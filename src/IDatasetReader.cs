namespace Quarry;

public interface IDatasetReader
{
    ColumnSchema GetSchema(string datasetPath);
    long CountRows(string datasetPath, SqlFilter filter);
    (List<string> Columns, List<List<string>> Rows) GetSampleRows(string datasetPath, int limit);
}
