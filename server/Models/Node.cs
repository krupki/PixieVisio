using System;
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace PixieVisio.Server.Models
{
    [Table("nodes")]
    public class Node
    {
        [Key]
        public string Id { get; set; } = Guid.NewGuid().ToString();

        public string ModelId { get; set; } = "default";

        public double X { get; set; }
        public double Y { get; set; }

        public string Text { get; set; } = string.Empty;

        public string Color { get; set; } = "#f4f4f4";

        public static double CalculateMaxNodes()
        {
            return 1;
        }
    }
}
